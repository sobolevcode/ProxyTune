'use strict';

var fs = require('fs');
var http = require('http');
var https = require('https');
var cp = require('child_process');
var exec = cp.exec;
var execFile = cp.execFile;
var urlModule = require('url');
var os = require('os');
var dns = require('dns');
var net = require('net');
var zlib = require('zlib');
var crypto = require('crypto');

try {
    var v8 = require('v8');
    v8.setFlagsFromString('--max-old-space-size=32');
} catch (e) {}

var APP_ID = 'com.proxytune';
var SERVICE_ID = 'com.proxytune.service';

var BASE_PATH = __dirname;
var IS_ROOT_PROCESS = (typeof process.getuid === 'function') && (process.getuid() === 0);

var arch = os.arch();
var xrayExec = (arch === 'arm64' || arch === 'aarch64') ? 'xray-arm64' : 'xray-arm';
var awgGoExec = (arch === 'arm64' || arch === 'aarch64') ? 'amneziawg-go-arm64' : 'amneziawg-go-arm';
var awgToolExec = (arch === 'arm64' || arch === 'aarch64') ? 'awg-arm64' : 'awg-arm';

var BIN_XRAY = BASE_PATH + '/bin/' + xrayExec;
var BIN_AWG_GO = BASE_PATH + '/bin/' + awgGoExec;
var BIN_AWG_TOOL = BASE_PATH + '/bin/' + awgToolExec;
var MODERN_CURL = BASE_PATH + '/bin/curl-modern';

var RUNTIME_PATH = '/tmp/proxytune_data';
var SAVE_PATH = BASE_PATH + '/save_data';

var CONFIG_PATH = RUNTIME_PATH + '/config.json';
var RUNTIME_CONFIG_PATH = RUNTIME_PATH + '/config.runtime.json';
var AWG_CONFIG_PATH = RUNTIME_PATH + '/awg.conf';
var LINK_FILE = SAVE_PATH + '/current_link.txt';
var HISTORY_FILE = SAVE_PATH + '/history.json';
var HWID_FILE = SAVE_PATH + '/hwid.txt';
var PARSE_ERROR_LOG = RUNTIME_PATH + '/parse_error.log';

var RUN_FLAG = RUNTIME_PATH + '/running';
var START_SCRIPT = RUNTIME_PATH + '/start_vpn.sh';
var STOP_SCRIPT = RUNTIME_PATH + '/stop_vpn.sh';
var WATCHDOG_SCRIPT = RUNTIME_PATH + '/watchdog.sh';
var WATCHDOG_PID_FILE = RUNTIME_PATH + '/watchdog.pid';
var PID_FILE = RUNTIME_PATH + '/xray.pid';
var START_LOG = RUNTIME_PATH + '/startup.log';
var DIE_FLAG = RUNTIME_PATH + '/die';
var IPV6_BACKUP_FILE = RUNTIME_PATH + '/ipv6-before';
var ENDPOINT_ROUTE_FILE = RUNTIME_PATH + '/endpoint-route';

var INIT_D_SCRIPT = '/var/lib/webosbrew/init.d/99-proxytune';
var AUTOSTART_FLAG = SAVE_PATH + '/autostart_enabled.txt';

var hasLink = false;
var currentLink = '';
var linkHistory = [];
var pendingAction = '';
var isBusy = false;
var deviceHwid = '';

function shellQuote(s) {
    return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

function sendJson(res, statusCode, obj) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
}

// === ВЫПОЛНЕНИЕ ROOT-КОМАНД (напрямую при uid=0, через luna-send-pub на webOS 6..26) ===
function execRoot(command, callback, customTimeout) {
    var timeoutMs = customTimeout || 45000;

    if (IS_ROOT_PROCESS) {
        exec(command, { timeout: timeoutMs, maxBuffer: 1048576 }, function(err, stdout, stderr) {
            if (err) {
                return callback(new Error((stderr || err.message || 'Ошибка выполнения команды').trim()));
            }
            callback(null, stdout || '');
        });
        return;
    }

    var payload = JSON.stringify({ command: command });
    execFile(
        '/usr/bin/luna-send-pub',
        ['-n', '1', 'luna://org.webosbrew.hbchannel.service/exec', payload],
        { timeout: timeoutMs, maxBuffer: 1048576 },
        function(err, stdout, stderr) {
            var raw = (stdout || '').trim();
            var reply = null;
            try {
                var firstBrace = raw.indexOf('{');
                var lastBrace = raw.lastIndexOf('}');
                if (firstBrace !== -1 && lastBrace > firstBrace) {
                    reply = JSON.parse(raw.substring(firstBrace, lastBrace + 1));
                }
            } catch (_) {}

            if (!reply) {
                var detail = (stderr || raw || (err && err.message) || 'timeout').trim();
                if (detail.length > 120) detail = detail.substring(0, 120) + '...';
                return callback(new Error('Root-служба HBC не отвечает (' + detail + ')'));
            }
            if (err || reply.returnValue !== true) {
                return callback(new Error(reply.errorText || (err && err.message) || 'Root-служба отклонила команду'));
            }
            callback(null, reply.stdoutString || '');
        }
    );
}

// === ЗАПАСНАЯ КОМАНДА ЧИСТОЙ ОСТАНОВКИ ===
function buildStopCommand(withLog) {
    var cmds = [];
    if (withLog) {
        cmds.push('echo "[STOP] Запуск резервной остановки..." >> ' + START_LOG + ' 2>/dev/null');
    }
    cmds.push('touch ' + DIE_FLAG);
    cmds.push('WP=$(cat ' + WATCHDOG_PID_FILE + ' 2>/dev/null); if [ -n "$WP" ]; then kill -9 $WP 2>/dev/null; fi');
    cmds.push('XP=$(cat ' + PID_FILE + ' 2>/dev/null); if [ -n "$XP" ]; then kill $XP 2>/dev/null; sleep 1; kill -9 $XP 2>/dev/null; fi');
    cmds.push('killall -9 ' + xrayExec + ' ' + awgGoExec + ' 2>/dev/null');
    cmds.push('ip link delete tun0 2>/dev/null');
    cmds.push('ip link delete awg0 2>/dev/null');
    cmds.push('rm -f /var/run/wireguard/awg0.sock 2>/dev/null');
    cmds.push('iptables -t nat -D POSTROUTING -o tun0 -j MASQUERADE 2>/dev/null');
    cmds.push('iptables -t nat -D POSTROUTING -o awg0 -j MASQUERADE 2>/dev/null');
    cmds.push('if [ -f ' + IPV6_BACKUP_FILE + ' ]; then while read key val; do if [ -n "$key" ] && [ -n "$val" ]; then sysctl -w "$key=$val" >/dev/null 2>&1; fi; done < ' + IPV6_BACKUP_FILE + '; rm -f ' + IPV6_BACKUP_FILE + '; fi');
    cmds.push('ER=$(cat ' + ENDPOINT_ROUTE_FILE + ' 2>/dev/null); if [ -n "$ER" ]; then ip route del $ER 2>/dev/null; fi');
    cmds.push('rm -f ' + RUN_FLAG + ' ' + PID_FILE + ' ' + WATCHDOG_PID_FILE + ' ' + ENDPOINT_ROUTE_FILE + ' ' + DIE_FLAG);
    if (withLog) {
        cmds.push('echo "[STOP] Выполнена остановка VPN" >> ' + START_LOG + ' 2>/dev/null');
    }
    cmds.push('true');
    return cmds.join('; ');
}

// === АВАРИЙНАЯ ЗАГЛУШКА, ЕСЛИ НЕТ ROOT / HOMEBREW CHANNEL ===
function startErrorFallback(message) {
    try {
        var Service = require('webos-service');
        var svc = new Service(SERVICE_ID);
        if (svc.activityManager) svc.activityManager.idleTimeout = 31536000000;
        svc.register('ping', function(m) {
            m.respond({ returnValue: true, error: message });
        });
    } catch (_) {}

    http.createServer(function(req, res) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
        if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }
        sendJson(res, 200, {
            success: false,
            running: false,
            hasLink: false,
            history: [],
            error: message,
            log: message
        });
    }).listen(8888, '0.0.0.0');
}

// === ПОДГОТОВКА КАТАЛОГОВ И ПРАВ ДО СТАРТА СЛУЖБЫ ===
function ensureStorageAndStart(onReady) {
    if (IS_ROOT_PROCESS) {
        if (!fs.existsSync(RUNTIME_PATH)) { try { fs.mkdirSync(RUNTIME_PATH, 448); } catch (e) {} }
        if (!fs.existsSync(SAVE_PATH)) { try { fs.mkdirSync(SAVE_PATH, 448); } catch (e) {} }
        try { fs.chmodSync(MODERN_CURL, 493); } catch (e) {}
        return onReady();
    }

    var uid = (typeof process.getuid === 'function') ? process.getuid() : 0;
    var gid = (typeof process.getgid === 'function') ? process.getgid() : 0;
    var paths = shellQuote(SAVE_PATH) + ' ' + shellQuote(RUNTIME_PATH);
    var cmds = [
        'mkdir -p ' + paths + ' && chown ' + uid + ':' + gid + ' ' + paths + ' && chmod 700 ' + paths
    ];

    var saveFiles = ['current_link.txt', 'history.json', 'hwid.txt', 'autostart_enabled.txt'];
    for (var i = 0; i < saveFiles.length; i++) {
        var sf = shellQuote(SAVE_PATH + '/' + saveFiles[i]);
        cmds.push('if [ -f ' + sf + ' ] && [ ! -L ' + sf + ' ]; then chown ' + uid + ':' + gid + ' ' + sf + ' && chmod 600 ' + sf + '; fi');
    }

    var runtimeFiles = ['config.json', 'awg.conf', 'start_vpn.sh', 'stop_vpn.sh', 'watchdog.sh', 'toggle_autostart.sh', '99-proxytune.sh', 'parse_error.log'];
    for (var j = 0; j < runtimeFiles.length; j++) {
        var rf = shellQuote(RUNTIME_PATH + '/' + runtimeFiles[j]);
        cmds.push('if [ -f ' + rf + ' ] && [ ! -L ' + rf + ' ]; then chown ' + uid + ':' + gid + ' ' + rf + ' && chmod 600 ' + rf + '; fi');
    }

    cmds.push('chmod 755 ' + shellQuote(MODERN_CURL) + ' 2>/dev/null || true');

    execRoot(cmds.join('; '), function(err) {
        if (!err) {
            try {
                fs.writeFileSync(SAVE_PATH + '/.write-test', 'ok');
                fs.unlinkSync(SAVE_PATH + '/.write-test');
                return onReady();
            } catch (writeErr) {
                err = writeErr;
            }
        }
        startErrorFallback(err ? err.message : 'Нет прав на запись в save_data');
    });
}

// === WATCHDOG С МГНОВЕННОЙ ОСТАНОВКОЙ ПО DIE_FLAG (работает от root) ===
function writeWatchdog() {
    var wdCmds = [
        '#!/bin/sh',
        'TICK=0',
        'cleanup_all() {',
        '  P_PID=$(cat ' + PID_FILE + ' 2>/dev/null)',
        '  if [ -n "$P_PID" ]; then kill $P_PID 2>/dev/null; sleep 1; kill -9 $P_PID 2>/dev/null; fi',
        '  killall -9 ' + xrayExec + ' ' + awgGoExec + ' 2>/dev/null',
        '  ip link delete tun0 2>/dev/null',
        '  ip link delete awg0 2>/dev/null',
        '  rm -f /var/run/wireguard/awg0.sock 2>/dev/null',
        '  iptables -t nat -D POSTROUTING -o tun0 -j MASQUERADE 2>/dev/null',
        '  iptables -t nat -D POSTROUTING -o awg0 -j MASQUERADE 2>/dev/null',
        '  if [ -f ' + IPV6_BACKUP_FILE + ' ]; then',
        '    while read key val; do',
        '      if [ -n "$key" ] && [ -n "$val" ]; then sysctl -w "$key=$val" >/dev/null 2>&1; fi',
        '    done < ' + IPV6_BACKUP_FILE,
        '    rm -f ' + IPV6_BACKUP_FILE,
        '  fi',
        '  ER=$(cat ' + ENDPOINT_ROUTE_FILE + ' 2>/dev/null)',
        '  if [ -n "$ER" ]; then ip route del $ER 2>/dev/null; fi',
        '  rm -f ' + RUN_FLAG + ' ' + PID_FILE + ' ' + WATCHDOG_PID_FILE + ' ' + ENDPOINT_ROUTE_FILE + ' ' + DIE_FLAG,
        '}',
        'while true; do',
        '  if [ -f ' + DIE_FLAG + ' ]; then',
        '    echo \'[WATCHDOG] Получен сигнал на остановку (DIE_FLAG)\' >> ' + START_LOG,
        '    cleanup_all',
        '    echo \'[STOP] VPN успешно остановлен (Watchdog)\' >> ' + START_LOG,
        '    exit 0',
        '  fi',
        '  TICK=$((TICK+1))',
        '  if [ $TICK -ge 5 ]; then',
        '    TICK=0',
        '    P_PID=$(cat ' + PID_FILE + ' 2>/dev/null)',
        '    if [ -z "$P_PID" ] || ! kill -0 $P_PID 2>/dev/null; then',
        '      echo \'[WATCHDOG] КРИТИЧЕСКИЙ СБОЙ: Процесс ядра мертв! Очистка...\' >> ' + START_LOG,
        '      cleanup_all',
        '      exit 1',
        '    fi',
        '  fi',
        '  sleep 1',
        'done'
    ].join('\n');
    try {
        fs.writeFileSync(WATCHDOG_SCRIPT, wdCmds);
        try { fs.chmodSync(WATCHDOG_SCRIPT, 493); } catch (ce) {}
        return true;
    } catch (e) {
        return false;
    }
}

function decodeBase64(str) {
    try {
        if (typeof Buffer.from === 'function') {
            return Buffer.from(str, 'base64').toString('utf8');
        } else {
            return new Buffer(str, 'base64').toString('utf8');
        }
    } catch (e) { return ''; }
}

function expandJsonProfiles(value) {
    var source = Array.isArray(value) ? value : [value];
    var expanded = [];
    for (var si = 0; si < source.length; si++) {
        var item = source[si];
        var outs = (item && item.outbounds) || [];
        var found = false;
        for (var oi = 0; oi < outs.length; oi++) {
            if (/^(vless|trojan|shadowsocks)$/.test(outs[oi].protocol)) {
                expanded.push({
                    outbounds: [outs[oi]],
                    remarks: outs[oi].tag || item.remarks,
                    meta: item.meta
                });
                found = true;
            }
        }
        if (!found) expanded.push(item);
    }
    return expanded;
}

function convertJsonToUri(jsonObj) {
    try {
        var outbounds = jsonObj.outbounds || [];
        var targetOutbound = null;
        for (var i = 0; i < outbounds.length; i++) {
            var proto = outbounds[i].protocol;
            if (proto === 'vless' || proto === 'trojan' || proto === 'shadowsocks') {
                targetOutbound = outbounds[i];
                break;
            }
        }
        if (!targetOutbound) return null;

        var protocol = targetOutbound.protocol;
        var stream = targetOutbound.streamSettings || {};
        var network = stream.network === 'raw' ? 'tcp' : (stream.network || 'tcp');
        var security = stream.security || 'none';

        var address = '', port = 443, passwordOrId = '', flow = '', method = '';

        if (protocol === 'vless') {
            var vnext = targetOutbound.settings && targetOutbound.settings.vnext && targetOutbound.settings.vnext[0];
            if (!vnext) return null;
            address = vnext.address; port = vnext.port;
            passwordOrId = vnext.users && vnext.users[0] && vnext.users[0].id;
            flow = (vnext.users && vnext.users[0] && vnext.users[0].flow) || '';
        } else if (protocol === 'trojan' || protocol === 'shadowsocks') {
            var servers = targetOutbound.settings && targetOutbound.settings.servers && targetOutbound.settings.servers[0];
            if (!servers) return null;
            address = servers.address; port = servers.port;
            passwordOrId = servers.password;
            if (protocol === 'shadowsocks') { method = servers.method || 'aes-256-gcm'; }
        }

        var uri = '';
        if (protocol === 'vless') {
            uri = 'vless://' + passwordOrId + '@' + address + ':' + port + '?type=' + network + '&security=' + security;
            if (flow) uri += '&flow=' + encodeURIComponent(flow);
        } else if (protocol === 'trojan') {
            uri = 'trojan://' + passwordOrId + '@' + address + ':' + port + '?type=' + network + '&security=' + security;
        } else if (protocol === 'shadowsocks') {
            var authStr = encodeURIComponent(method) + ':' + encodeURIComponent(passwordOrId);
            uri = 'ss://' + authStr + '@' + address + ':' + port;
        }

        if (protocol === 'vless' || protocol === 'trojan') {
            if (security === 'reality' && stream.realitySettings) {
                var rs = stream.realitySettings;
                if (rs.publicKey) uri += '&pbk=' + encodeURIComponent(rs.publicKey);
                if (rs.serverName) uri += '&sni=' + encodeURIComponent(rs.serverName);
                if (rs.shortId) uri += '&sid=' + encodeURIComponent(rs.shortId);
                if (rs.fingerprint) uri += '&fp=' + encodeURIComponent(rs.fingerprint);
                if (rs.spiderX) uri += '&spx=' + encodeURIComponent(rs.spiderX);
            } else if (security === 'tls' && stream.tlsSettings) {
                var ts = stream.tlsSettings;
                if (ts.serverName) uri += '&sni=' + encodeURIComponent(ts.serverName);
                if (ts.fingerprint) uri += '&fp=' + encodeURIComponent(ts.fingerprint);
                if (ts.alpn && Array.isArray(ts.alpn)) uri += '&alpn=' + encodeURIComponent(ts.alpn.join(','));
            }

            if (stream.grpcSettings) {
                if (stream.grpcSettings.serviceName) uri += '&serviceName=' + encodeURIComponent(stream.grpcSettings.serviceName);
                if (stream.grpcSettings.multiMode) uri += '&mode=multi';
            }
            if (network === 'ws' && stream.wsSettings) {
                if (stream.wsSettings.path) uri += '&path=' + encodeURIComponent(stream.wsSettings.path);
                if (stream.wsSettings.headers && stream.wsSettings.headers.Host) uri += '&host=' + encodeURIComponent(stream.wsSettings.headers.Host);
            }
            var extraTransport = stream.xhttpSettings || stream.splithttpSettings || stream.httpupgradeSettings;
            if (extraTransport) {
                if (extraTransport.path) uri += '&path=' + encodeURIComponent(extraTransport.path);
                if (extraTransport.host) uri += '&host=' + encodeURIComponent(extraTransport.host);
            }
        }

        var remarks = jsonObj.remarks || (jsonObj.meta && jsonObj.meta.serverDescription) || ('JSON ' + protocol.toUpperCase());
        uri += '#' + encodeURIComponent(remarks);
        return uri;
    } catch (e) { return null; }
}

function UniversalParser(text) {
    if (!text) return null;
    text = text.trim();

    if (text.indexOf('[Interface]') !== -1 && text.indexOf('[Peer]') !== -1) {
        try {
            var localIpMatch = text.match(/Address\s*=\s*([0-9\.\/]+)/i);
            var endpointMatch = text.match(/Endpoint\s*=\s*([a-zA-Z0-9\.\-]+):(\d+)/i);

            var cleanedConfig = text.split('\n').filter(function(line) {
                return !/^(Address|DNS|MTU|PostUp|PostDown|PreUp|PreDown)\s*=/i.test(line.trim());
            }).join('\n');

            if (localIpMatch && endpointMatch) {
                return {
                    type: 'amneziawg',
                    local_ip: localIpMatch[1],
                    server: endpointMatch[1],
                    server_port: parseInt(endpointMatch[2], 10),
                    raw_config: cleanedConfig
                };
            }
        } catch (e) { return null; }
    }

    if (text.indexOf('vless://') === 0) {
        try {
            var u = urlModule.parse(text, true);
            var outbound = { type: 'vless', server: u.hostname, server_port: parseInt(u.port, 10) || 443, uuid: u.auth || '' };
            var q = u.query;

            if (q.flow) outbound.flow = q.flow;

            var rawSni = q.sni || u.hostname;
            var cleanSni = rawSni ? rawSni.split(',')[0].trim() : u.hostname;

            if (q.type === 'ws') {
                outbound.transport = { type: 'ws', path: q.path || '/', headers: { Host: q.host || cleanSni } };
            } else if (q.type === 'grpc') {
                outbound.transport = { type: 'grpc', service_name: q.serviceName || q.path || '', multi_mode: q.mode === 'multi' };
            } else if (q.type === 'xhttp' || q.type === 'http' || q.type === 'httpupgrade') {
                outbound.transport = { type: q.type, path: q.path || '/' };
                var httpHost = q.host || cleanSni;
                if (httpHost) outbound.transport.host = [httpHost];
            }

            if (q.security === 'reality') {
                outbound.tls = {
                    enabled: true,
                    server_name: cleanSni,
                    utls: { fingerprint: q.fp || 'firefox' },
                    reality: { enabled: true, public_key: q.pbk || '' }
                };
                if (typeof q.sid !== 'undefined') outbound.tls.reality.short_id = q.sid;
                if (typeof q.spx !== 'undefined') outbound.tls.reality.spider_x = q.spx;
            } else if (q.security === 'tls') {
                outbound.tls = { enabled: true, server_name: cleanSni, utls: { fingerprint: q.fp || 'firefox' } };
            }
            if (q.alpn && outbound.tls) {
                outbound.tls.alpn = q.alpn.split(',').map(function(s) { return s.trim(); });
            }
            return outbound;
        } catch (e) { return null; }
    }

    if (text.indexOf('trojan://') === 0) {
        try {
            var u4 = urlModule.parse(text, true); var q4 = u4.query;
            var outbound4 = { type: 'trojan', server: u4.hostname, server_port: parseInt(u4.port, 10) || 443, password: u4.auth || '' };

            var rawSni4 = q4.sni || u4.hostname;
            var cleanSni4 = rawSni4 ? rawSni4.split(',')[0].trim() : u4.hostname;

            if (q4.type === 'ws') {
                outbound4.transport = { type: 'ws', path: q4.path || '/', headers: { Host: q4.host || cleanSni4 } };
            } else if (q4.type === 'grpc') {
                outbound4.transport = { type: 'grpc', service_name: q4.serviceName || q4.path || '', multi_mode: q4.mode === 'multi' };
            } else if (q4.type === 'xhttp' || q4.type === 'http' || q4.type === 'httpupgrade') {
                outbound4.transport = { type: q4.type, path: q4.path || '/' };
                var httpHost4 = q4.host || cleanSni4;
                if (httpHost4) outbound4.transport.host = [httpHost4];
            }

            outbound4.tls = { enabled: true, server_name: cleanSni4 };
            if (q4.fp) outbound4.tls.utls = { fingerprint: q4.fp };
            if (q4.alpn && outbound4.tls) {
                outbound4.tls.alpn = q4.alpn.split(',').map(function(s) { return s.trim(); });
            }
            return outbound4;
        } catch (e) { return null; }
    }

    if (text.indexOf('ss://') === 0) {
        try {
            var u5 = urlModule.parse(text); var authStr = u5.auth || ''; var method = '', pass = '';
            if (authStr.indexOf(':') !== -1) {
                var parts = authStr.split(':'); method = decodeURIComponent(parts[0]); pass = decodeURIComponent(parts.slice(1).join(':'));
            } else {
                var b64 = decodeBase64(authStr);
                if (b64.indexOf(':') !== -1) { var parts2 = b64.split(':'); method = parts2[0]; pass = parts2.slice(1).join(':'); }
            }
            return { type: 'shadowsocks', server: u5.hostname, server_port: parseInt(u5.port, 10) || 8388, method: method || 'aes-256-gcm', password: pass };
        } catch (e) { return null; }
    }

    if (text.indexOf('socks5://') === 0) {
        try {
            var u3 = urlModule.parse(text); var auth3 = u3.auth ? u3.auth.split(':') : ['', ''];
            return { type: 'socks', server: u3.hostname, server_port: parseInt(u3.port, 10) || 1080, username: auth3[0] ? decodeURIComponent(auth3[0]) : '', password: auth3[1] ? decodeURIComponent(auth3[1]) : '' };
        } catch (e) { return null; }
    }

    return null;
}

function generateXrayConfig(outbound, bindUplink) {
    var config = {
        log: { loglevel: 'warning' },
        dns: {
            queryStrategy: 'UseIPv4',
            servers: ['8.8.8.8', '1.1.1.1', 'localhost']
        },
        inbounds: [{
            tag: 'tun-in',
            protocol: 'tun',
            settings: {
                name: 'tun0',
                mtu: 1500
            },
            sniffing: { enabled: true, destOverride: ['http', 'tls', 'quic'], routeOnly: false }
        }],
        outbounds: [],
        policy: {
            levels: { '8': { connIdle: 300, downlinkOnly: 1, handshake: 4, uplinkOnly: 1 } },
            system: { statsOutboundUplink: true, statsOutboundDownlink: true }
        },
        routing: {
            domainStrategy: 'IPIfNonMatch',
            rules: [
                { type: 'field', network: 'udp', port: '443', outboundTag: 'block' },
                { type: 'field', ip: ['::/0'], outboundTag: 'block' },
                { type: 'field', ip: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8'], outboundTag: 'direct' }
            ]
        }
    };

    var mainOutbound = { protocol: outbound.type, settings: {}, tag: 'proxy' };
    mainOutbound.mux = { concurrency: -1, enabled: false };

    var netType = 'tcp';
    if (outbound.transport) {
        netType = outbound.transport.type;
        if (netType === 'xhttp') { netType = 'splithttp'; }
    }

    if (outbound.type === 'vless') {
        var finalFlow = outbound.flow || '';
        mainOutbound.settings.vnext = [{ address: outbound.server, port: outbound.server_port, users: [{ id: outbound.uuid, encryption: 'none', flow: finalFlow, level: 8 }] }];
    } else if (outbound.type === 'trojan') {
        mainOutbound.settings.servers = [{ address: outbound.server, port: outbound.server_port, password: outbound.password, level: 8 }];
    } else if (outbound.type === 'shadowsocks') {
        mainOutbound.settings.servers = [{ address: outbound.server, port: outbound.server_port, method: outbound.method, password: outbound.password, level: 8 }];
    } else if (outbound.type === 'socks') {
        mainOutbound.settings.servers = [{ address: outbound.server, port: outbound.server_port, level: 8 }];
        if (outbound.username && outbound.password) { mainOutbound.settings.servers[0].users = [{ user: outbound.username, pass: outbound.password, level: 8 }]; }
    }

    var stream = {
        network: netType,
        security: outbound.tls ? (outbound.tls.reality ? 'reality' : 'tls') : 'none'
    };

    if (netType === 'tcp') { stream.tcpSettings = { header: { type: 'none' } }; }

    if (outbound.tls) {
        if (outbound.tls.reality) {
            stream.realitySettings = {
                fingerprint: outbound.tls.utls ? outbound.tls.utls.fingerprint : 'firefox',
                serverName: outbound.tls.server_name,
                publicKey: outbound.tls.reality.public_key
            };
            if (outbound.tls.reality.short_id) stream.realitySettings.shortId = outbound.tls.reality.short_id;
            if (outbound.tls.reality.spider_x && outbound.tls.reality.spider_x !== '/') stream.realitySettings.spiderX = outbound.tls.reality.spider_x;
        } else {
            stream.tlsSettings = { serverName: outbound.tls.server_name };
            if (outbound.tls.utls) stream.tlsSettings.fingerprint = outbound.tls.utls.fingerprint;
            if (outbound.tls.alpn) stream.tlsSettings.alpn = outbound.tls.alpn;
        }
    }

    if (outbound.transport) {
        if (outbound.transport.type === 'ws') {
            stream.wsSettings = { path: outbound.transport.path };
            if (outbound.transport.headers && outbound.transport.headers.Host) stream.wsSettings.headers = { Host: outbound.transport.headers.Host };
        } else if (outbound.transport.type === 'grpc') {
            stream.grpcSettings = { serviceName: outbound.transport.service_name || '', multiMode: outbound.transport.multi_mode || false };
        } else if (outbound.transport.type === 'xhttp' || outbound.transport.type === 'splithttp') {
            stream.splithttpSettings = { path: outbound.transport.path, host: outbound.transport.host ? outbound.transport.host[0] : '' };
        } else if (outbound.transport.type === 'httpupgrade') {
            stream.httpupgradeSettings = { path: outbound.transport.path, host: outbound.transport.host ? outbound.transport.host[0] : '' };
        }
    }

    mainOutbound.streamSettings = stream;
    config.outbounds.push(mainOutbound);
    config.outbounds.push({ protocol: 'freedom', tag: 'direct' });
    config.outbounds.push({ protocol: 'blackhole', tag: 'block' });

    if (bindUplink) {
        for (var oi = 0; oi < config.outbounds.length; oi++) {
            var ob = config.outbounds[oi];
            if (ob.protocol !== 'blackhole') {
                ob.streamSettings = ob.streamSettings || {};
                ob.streamSettings.sockopt = ob.streamSettings.sockopt || {};
                ob.streamSettings.sockopt.interface = '__PROXYTUNE_UPLINK__';
            }
        }
    }

    return config;
}

// === ГЕНЕРАЦИЯ СТАРТОВОГО СКРИПТА ===
function prepareStartScript(link, callback) {
    var outbound = UniversalParser(link || currentLink);
    if (!outbound) return callback(new Error('Добавьте ссылку или JSON вашего VPN-провайдера'));

    var serverHostname = outbound.server || '';
    if (!/^[a-zA-Z0-9._:-]+$/.test(serverHostname)) {
        return callback(new Error('Недопустимое имя VPN-сервера'));
    }

    dns.lookup(serverHostname, 4, function(err, address) {
        if (err || !address) {
            return callback(new Error('Ошибка DNS: не удалось определить IP для ' + serverHostname));
        }

        var resolvedIp = address;
        outbound.server = resolvedIp;

        try {
            if (!writeWatchdog()) {
                return callback(new Error('Не удалось создать watchdog.sh'));
            }

            var startCmds = [];
            startCmds.push('#!/bin/sh');
            startCmds.push('echo \'========================================\' > ' + START_LOG);
            startCmds.push('chmod 644 ' + START_LOG + ' 2>/dev/null || true');
            startCmds.push('echo \'ProxyTune VPN START - \' $(date) >> ' + START_LOG);
            startCmds.push('if ip route | grep -E \'^(0.0.0.0/1|128.0.0.0/1)\' | grep -v -E \'dev (tun0|awg0) \' >/dev/null; then echo \'[ERROR] Остановите другой VPN перед запуском\' >> ' + START_LOG + '; exit 1; fi');
            startCmds.push('VPN_START_OK=0');
            startCmds.push('cleanup_failed_start() { if [ "$VPN_START_OK" != "1" ]; then ' + buildStopCommand(false) + '; fi; }');
            startCmds.push('trap cleanup_failed_start EXIT');
            startCmds.push('echo \'========================================\' >> ' + START_LOG);

            startCmds.push('WP=$(cat ' + WATCHDOG_PID_FILE + ' 2>/dev/null); if [ -n "$WP" ]; then kill -9 $WP 2>/dev/null || true; fi');
            startCmds.push('OLD_PID=$(cat ' + PID_FILE + ' 2>/dev/null)');
            startCmds.push('if [ -n "$OLD_PID" ]; then kill -9 $OLD_PID 2>/dev/null || true; fi');
            startCmds.push('killall -9 ' + xrayExec + ' ' + awgGoExec + ' 2>/dev/null || true');
            startCmds.push('ip link delete tun0 2>/dev/null || true');
            startCmds.push('ip link delete awg0 2>/dev/null || true');
            startCmds.push('rm -f /var/run/wireguard/awg0.sock 2>/dev/null || true');
            startCmds.push('iptables -t nat -D POSTROUTING -o tun0 -j MASQUERADE 2>/dev/null || true');
            startCmds.push('iptables -t nat -D POSTROUTING -o awg0 -j MASQUERADE 2>/dev/null || true');
            startCmds.push('rm -f ' + DIE_FLAG + ' ' + RUN_FLAG + ' ' + PID_FILE + ' ' + WATCHDOG_PID_FILE + ' ' + RUNTIME_PATH + '/xray.log');

            startCmds.push('echo \'[INFO] Proxy Host: ' + serverHostname + '\' >> ' + START_LOG);
            startCmds.push('echo \'[INFO] Resolved IP: ' + resolvedIp + '\' >> ' + START_LOG);

            // Не трогаем lo, чтобы не ломать локальные службы webOS
            startCmds.push('if [ ! -f ' + IPV6_BACKUP_FILE + ' ]; then for key in net.ipv6.conf.all.disable_ipv6 net.ipv6.conf.default.disable_ipv6; do VAL=$(sysctl -n $key 2>/dev/null); if [ -n "$VAL" ]; then echo "$key $VAL"; fi; done > ' + IPV6_BACKUP_FILE + '; fi');
            startCmds.push('sysctl -w net.ipv6.conf.all.disable_ipv6=1 >/dev/null 2>&1 || true');
            startCmds.push('sysctl -w net.ipv6.conf.default.disable_ipv6=1 >/dev/null 2>&1 || true');
            startCmds.push('echo \'[OK] Протокол IPv6 отключен\' >> ' + START_LOG);

            startCmds.push('GW=$(ip route | awk \'/^default/ {for(i=1;i<=NF;i++) if($i=="via") {print $(i+1); exit}}\')');
            startCmds.push('IFACE=$(ip route | awk \'/^default/ {for(i=1;i<=NF;i++) if($i=="dev") {print $(i+1); exit}}\')');
            startCmds.push('if [ -n "$GW" ] && [ -n "$IFACE" ]; then');
            startCmds.push('  (ip route replace ' + resolvedIp + ' via $GW dev $IFACE 2>/dev/null || ip route add ' + resolvedIp + ' via $GW dev $IFACE 2>/dev/null) && echo ' + resolvedIp + ' > ' + ENDPOINT_ROUTE_FILE);
            startCmds.push('elif [ -n "$IFACE" ]; then');
            startCmds.push('  (ip route replace ' + resolvedIp + ' dev $IFACE 2>/dev/null || ip route add ' + resolvedIp + ' dev $IFACE 2>/dev/null) && echo ' + resolvedIp + ' > ' + ENDPOINT_ROUTE_FILE);
            startCmds.push('else');
            startCmds.push('  (ip route replace ' + resolvedIp + ' dev eth0 2>/dev/null || ip route add ' + resolvedIp + ' dev eth0 2>/dev/null) && echo ' + resolvedIp + ' > ' + ENDPOINT_ROUTE_FILE);
            startCmds.push('fi');

            if (outbound.type === 'amneziawg') {
                fs.writeFileSync(AWG_CONFIG_PATH, outbound.raw_config);
                startCmds.push('chmod 755 ' + BIN_AWG_GO + ' ' + BIN_AWG_TOOL);
                startCmds.push('echo \'[START] Запуск AmneziaWG...\' >> ' + START_LOG);

                startCmds.push('mkdir -p /var/run/wireguard 2>/dev/null || true');
                startCmds.push('export WG_I_PREFER_BUGGY_USERSPACE_TO_POLISHED_KMOD=1');
                startCmds.push('export AWG_I_PREFER_BUGGY_USERSPACE_TO_POLISHED_KMOD=1');
                startCmds.push('> ' + RUNTIME_PATH + '/xray.log');
                startCmds.push('chmod 644 ' + RUNTIME_PATH + '/xray.log 2>/dev/null || true');

                startCmds.push('nohup ' + BIN_AWG_GO + ' -f awg0 </dev/null >> ' + RUNTIME_PATH + '/xray.log 2>&1 &');
                startCmds.push('AWG_PID=$!');
                startCmds.push('echo $AWG_PID > ' + PID_FILE);

                startCmds.push('W=0; while [ $W -lt 10 ]; do');
                startCmds.push('  if ! kill -0 $AWG_PID 2>/dev/null; then echo \'[ERROR] AmneziaWG упал сразу после запуска!\' >> ' + START_LOG + '; exit 1; fi');
                startCmds.push('  if ip link show awg0 >/dev/null 2>&1; then break; fi');
                startCmds.push('  sleep 1; W=$((W+1))');
                startCmds.push('done');

                startCmds.push(BIN_AWG_TOOL + ' setconf awg0 ' + AWG_CONFIG_PATH + ' >> ' + START_LOG + ' 2>&1 || exit 1');
                var awgIp = outbound.local_ip.indexOf('/') !== -1 ? outbound.local_ip : (outbound.local_ip + '/24');
                startCmds.push('ip addr add ' + awgIp + ' dev awg0 >> ' + START_LOG + ' 2>&1 || exit 1');
                startCmds.push('ip link set awg0 mtu 1280 up >> ' + START_LOG + ' 2>&1 || exit 1');

                startCmds.push('ip route add 0.0.0.0/1 dev awg0 >> ' + START_LOG + ' 2>&1 || exit 1');
                startCmds.push('ip route add 128.0.0.0/1 dev awg0 >> ' + START_LOG + ' 2>&1 || exit 1');
                startCmds.push('iptables -t nat -A POSTROUTING -o awg0 -j MASQUERADE 2>/dev/null || true');
                startCmds.push('echo \'[OK] Интерфейс awg0 поднят и настроен\' >> ' + START_LOG);
            } else {
                fs.writeFileSync(CONFIG_PATH, JSON.stringify(generateXrayConfig(outbound, true), null, 2));
                startCmds.push('case "$IFACE" in \'\'|*[!a-zA-Z0-9_.:-]*) echo \'[ERROR] Не удалось определить сетевой интерфейс (IFACE)\' >> ' + START_LOG + '; exit 1;; esac');
                startCmds.push('sed "s/__PROXYTUNE_UPLINK__/$IFACE/g" ' + CONFIG_PATH + ' > ' + RUNTIME_CONFIG_PATH);
                startCmds.push('chmod 600 ' + RUNTIME_CONFIG_PATH + ' 2>/dev/null || true');
                startCmds.push('chmod 755 ' + BIN_XRAY);

                startCmds.push('echo \'[INFO] Проверка конфигурации Xray...\' >> ' + START_LOG);
                startCmds.push(BIN_XRAY + ' run -test -config ' + RUNTIME_CONFIG_PATH + ' >> ' + START_LOG + ' 2>&1');
                startCmds.push('if [ $? -ne 0 ]; then exit 1; fi');

                startCmds.push('echo \'[START] Запуск Xray...\' >> ' + START_LOG);
                startCmds.push('> ' + RUNTIME_PATH + '/xray.log');
                startCmds.push('chmod 644 ' + RUNTIME_PATH + '/xray.log 2>/dev/null || true');
                startCmds.push('nohup ' + BIN_XRAY + ' run -config ' + RUNTIME_CONFIG_PATH + ' </dev/null > ' + RUNTIME_PATH + '/xray.log 2>&1 &');
                startCmds.push('X_PID=$!');
                startCmds.push('echo $X_PID > ' + PID_FILE);

                startCmds.push('W=0; while [ $W -lt 10 ]; do');
                startCmds.push('  if ! kill -0 $X_PID 2>/dev/null; then echo \'[ERROR] Xray упал сразу после запуска! Порт занят или ошибка конфига.\' >> ' + START_LOG + '; exit 1; fi');
                startCmds.push('  if ip link show tun0 >/dev/null 2>&1; then break; fi');
                startCmds.push('  sleep 1; W=$((W+1))');
                startCmds.push('done');

                startCmds.push('ip link set tun0 mtu 1500 up >> ' + START_LOG + ' 2>&1 || exit 1');
                startCmds.push('ip addr add 198.18.0.1/24 dev tun0 >> ' + START_LOG + ' 2>&1 || exit 1');
                startCmds.push('ip route add 0.0.0.0/1 dev tun0 >> ' + START_LOG + ' 2>&1 || exit 1');
                startCmds.push('ip route add 128.0.0.0/1 dev tun0 >> ' + START_LOG + ' 2>&1 || exit 1');
                startCmds.push('iptables -t nat -A POSTROUTING -o tun0 -j MASQUERADE 2>/dev/null || true');
                startCmds.push('echo \'[OK] Интерфейс tun0 поднят и настроен (uplink: \'$IFACE\')\' >> ' + START_LOG);
            }

            startCmds.push('VPN_START_OK=1');
            startCmds.push('touch ' + RUN_FLAG);
            startCmds.push('chmod 644 ' + RUN_FLAG + ' 2>/dev/null || true');
            startCmds.push('nohup sh ' + WATCHDOG_SCRIPT + ' </dev/null >> ' + START_LOG + ' 2>&1 &');
            startCmds.push('echo $! > ' + WATCHDOG_PID_FILE);
            startCmds.push('echo \'========================================\' >> ' + START_LOG);
            startCmds.push('echo \'[OK] VPN УСПЕШНО ЗАПУЩЕН!\' >> ' + START_LOG);

            fs.writeFileSync(START_SCRIPT, startCmds.join('\n'));
            try { fs.chmodSync(START_SCRIPT, 493); } catch (ce) {}
            callback(null, 'sh ' + START_SCRIPT);
        } catch (innerE) {
            callback(innerE);
        }
    });
}

function findLinkIndex(linkStr) {
    for (var i = 0; i < linkHistory.length; i++) {
        if (linkHistory[i].link === linkStr) return i;
    }
    return -1;
}

// === ОСНОВНАЯ ИНИЦИАЛИЗАЦИЯ СЛУЖБЫ И HTTP-СЕРВЕРА ===
function initAndListen() {
    // 1. HWID
    if (fs.existsSync(HWID_FILE)) {
        try { deviceHwid = fs.readFileSync(HWID_FILE, 'utf8').trim(); } catch (e) {}
    }
    if (!deviceHwid || deviceHwid.length < 10) {
        var mac = '00:00:00:00:00:00';
        try {
            var ifaces = os.networkInterfaces();
            for (var dev in ifaces) {
                for (var i = 0; i < ifaces[dev].length; i++) {
                    if (!ifaces[dev][i].internal && ifaces[dev][i].mac && ifaces[dev][i].mac !== '00:00:00:00:00:00') {
                        mac = ifaces[dev][i].mac;
                        break;
                    }
                }
                if (mac !== '00:00:00:00:00:00') break;
            }
        } catch (e) {}

        var rawHash = crypto.createHash('md5').update(mac + 'ProxyTuneHWID').digest('hex');
        deviceHwid = rawHash.substring(0, 8) + '-' + rawHash.substring(8, 12) + '-' +
                     rawHash.substring(12, 16) + '-' + rawHash.substring(16, 20) + '-' +
                     rawHash.substring(20, 32);
        try { fs.writeFileSync(HWID_FILE, deviceHwid); } catch (e) {}
    }

    // 2. Watchdog
    writeWatchdog();

    // 3. Загрузка сохранённой ссылки и истории
    if (fs.existsSync(LINK_FILE)) {
        try {
            currentLink = fs.readFileSync(LINK_FILE, 'utf8').trim();
            if (currentLink) {
                hasLink = true;
                var bootOutbound = UniversalParser(currentLink);
                if (bootOutbound && bootOutbound.type !== 'amneziawg') {
                    fs.writeFileSync(CONFIG_PATH, JSON.stringify(generateXrayConfig(bootOutbound, false), null, 2));
                }
            }
        } catch (e) {}
    }

    if (fs.existsSync(HISTORY_FILE)) {
        try {
            var parsed = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
            if (!Array.isArray(parsed)) parsed = [];
            linkHistory = [];
            for (var hi = 0; hi < parsed.length; hi++) {
                if (typeof parsed[hi] === 'string') { linkHistory.push({ link: parsed[hi], fav: false }); }
                else if (parsed[hi] && parsed[hi].link) { linkHistory.push(parsed[hi]); }
            }
            if (linkHistory.length > 8) {
                linkHistory = linkHistory.slice(0, 8);
            }
        } catch (e) { linkHistory = []; }
    }

    // 4. Регистрация webOS-сервиса
    try {
        var Service = require('webos-service');
        var service = new Service(SERVICE_ID);
        if (service.activityManager) service.activityManager.idleTimeout = 31536000000;
        process.exit = function() {};

        service.register('ping', function(message) { message.respond({ returnValue: true, msg: 'Pong!' }); });

        service.register('autostart', function(message) {
            message.respond({ returnValue: true, msg: 'Autostart initiated' });

            if (fs.existsSync(LINK_FILE)) {
                var savedLink = fs.readFileSync(LINK_FILE, 'utf8').trim();
                if (savedLink) {
                    prepareStartScript(savedLink, function(err, cmd) {
                        if (!err && cmd) {
                            execRoot(cmd, function() {});
                        }
                    });
                }
            }
        });
    } catch (e) {}

    // 5. HTTP API-сервер
    var server = http.createServer(function(req, res) {
        var origin = req.headers && req.headers.origin;
        if (
            origin &&
            origin !== 'null' &&
            !/^file:/.test(origin) &&
            !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) &&
            origin !== 'http://' + req.headers.host
        ) {
            res.writeHead(403);
            res.end('Forbidden origin');
            return;
        }

        res.setHeader('Access-Control-Allow-Origin', origin || '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
        if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

        if (req.method === 'GET' && req.url === '/autostart-status') {
            sendJson(res, 200, { enabled: fs.existsSync(AUTOSTART_FLAG) });
            return;
        }

        if (req.method === 'POST' && req.url === '/toggle-autostart') {
            var bodyAuto = ''; req.on('data', function(c) { bodyAuto += c; });
            req.on('end', function() {
                try {
                    var data = JSON.parse(bodyAuto);
                    var cmdScript = RUNTIME_PATH + '/toggle_autostart.sh';
                    var cmds = [];
                    cmds.push('#!/bin/sh');

                    if (data.enable) {
                        var scriptContent = '#!/bin/sh\n' +
                            '(\n' +
                            '    count=0\n' +
                            '    while [ $count -lt 30 ]; do\n' +
                            '        if ping -c 1 -W 1 8.8.8.8 > /dev/null 2>&1 || ping -c 1 -W 1 1.1.1.1 > /dev/null 2>&1; then\n' +
                            '            break\n' +
                            '        fi\n' +
                            '        sleep 2\n' +
                            '        count=$((count+1))\n' +
                            '    done\n' +
                            '    sleep 3\n' +
                            '    /usr/bin/luna-send -n 1 -a ' + APP_ID + ' luna://' + SERVICE_ID + '/autostart \'{}\' > /dev/null 2>&1\n' +
                            ') &\n';

                        fs.writeFileSync(RUNTIME_PATH + '/99-proxytune.sh', scriptContent);

                        cmds.push('mkdir -p /var/lib/webosbrew/init.d 2>/dev/null || true');
                        cmds.push('cp ' + RUNTIME_PATH + '/99-proxytune.sh ' + INIT_D_SCRIPT);
                        cmds.push('chmod 755 ' + INIT_D_SCRIPT);
                    } else {
                        cmds.push('rm -f ' + INIT_D_SCRIPT);
                    }

                    fs.writeFileSync(cmdScript, cmds.join('\n'));
                    try { fs.chmodSync(cmdScript, 493); } catch (ce) {}

                    execRoot('sh ' + cmdScript, function(err) {
                        if (err) return sendJson(res, 400, { success: false, error: err.message });
                        try {
                            if (data.enable) {
                                fs.writeFileSync(AUTOSTART_FLAG, '1');
                            } else {
                                if (fs.existsSync(AUTOSTART_FLAG)) fs.unlinkSync(AUTOSTART_FLAG);
                            }
                        } catch (flagErr) {}
                        sendJson(res, 200, { success: true, enabled: data.enable });
                    });
                } catch (e) {
                    sendJson(res, 400, { success: false });
                }
            });
            return;
        }

        if (req.method === 'GET' && req.url === '/') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            try { var html = fs.readFileSync(BASE_PATH + '/phone.html', 'utf8'); res.end(html); }
            catch (e) { res.writeHead(404); res.end('Not found'); }
            return;
        }
        if (req.method === 'GET' && req.url === '/css/phone.css') {
            try { var css = fs.readFileSync(BASE_PATH + '/css/phone.css', 'utf8'); res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' }); res.end(css); }
            catch (e) { res.writeHead(404); res.end(''); }
            return;
        }
        if (req.method === 'GET' && req.url === '/help.png') {
            try { var img = fs.readFileSync(BASE_PATH + '/help.png'); res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(img); }
            catch (e) { res.writeHead(404); res.end(''); }
            return;
        }

        if (req.method === 'GET' && req.url === '/status') {
            var isRunning = fs.existsSync(RUN_FLAG);
            var tvIp = '';
            var isAutoEnabled = fs.existsSync(AUTOSTART_FLAG);

            try {
                var interfaces = os.networkInterfaces();
                for (var devName in interfaces) {
                    if (devName === 'lo' || devName === 'tun0' || devName === 'awg0') continue;
                    var iface = interfaces[devName];
                    for (var ii = 0; ii < iface.length; ii++) {
                        var alias = iface[ii];
                        if (alias.family === 'IPv4' && alias.address !== '127.0.0.1' && !alias.internal) { tvIp = alias.address; break; }
                    }
                    if (tvIp) break;
                }
            } catch (e) {}

            sendJson(res, 200, {
                running: isRunning,
                hasLink: hasLink,
                link: currentLink,
                ip: tvIp,
                history: linkHistory,
                pendingAction: pendingAction,
                autostart: isAutoEnabled
            });
            return;
        }

        if (req.method === 'POST' && req.url === '/parse-sub') {
            var bodySub = ''; req.on('data', function(c) { bodySub += c; });
            req.on('end', function() {
                function sendParseError(resObj, errorText) {
                    try { fs.writeFileSync(PARSE_ERROR_LOG, 'TIME: ' + new Date().toISOString() + '\nERROR: ' + errorText + '\n'); } catch (e) {}
                    sendJson(resObj, 400, { success: false, error: errorText });
                }

                try {
                    var data = JSON.parse(bodySub);

                    function processText(textResponse) {
                        try {
                            var text = textResponse.trim();
                            var validLinks = [];

                            if (text.indexOf('<') === 0 || text.toLowerCase().indexOf('<!doctype') === 0) {
                                var snippet = text.substring(0, 100).replace(/</g, '[').replace(/>/g, ']').replace(/\n/g, ' ');
                                sendParseError(res, 'Блокировка HTML: ' + snippet + '...');
                                return;
                            }

                            var isJsonProcessed = false;

                            if (text.indexOf('{') === 0 || text.indexOf('[') === 0) {
                                try {
                                    var parsedJson = JSON.parse(text);
                                    if (parsedJson.links && Array.isArray(parsedJson.links)) {
                                        for (var m = 0; m < parsedJson.links.length; m++) {
                                            var lStr = parsedJson.links[m];
                                            if (typeof lStr === 'string' && /(vless|trojan|ss|socks5):\/\//i.test(lStr)) {
                                                var nL = 'Сервер ' + (validLinks.length + 1);
                                                var hL = lStr.indexOf('#');
                                                if (hL !== -1) { try { nL = decodeURIComponent(lStr.substring(hL + 1)); } catch (e) {} }
                                                var existsL = false;
                                                for (var jl = 0; jl < validLinks.length; jl++) { if (validLinks[jl].link === lStr) { existsL = true; break; } }
                                                if (!existsL) validLinks.push({ name: nL, link: lStr });
                                                if (validLinks.length >= 1000) break;
                                            }
                                        }
                                        if (validLinks.length > 0) isJsonProcessed = true;
                                    } else {
                                        var jsonArray = expandJsonProfiles(parsedJson);
                                        for (var k = 0; k < jsonArray.length; k++) {
                                            var generatedUri = convertJsonToUri(jsonArray[k]);
                                            if (generatedUri) {
                                                var nameJson = 'JSON Сервер';
                                                var hashIdxJson = generatedUri.indexOf('#');
                                                if (hashIdxJson !== -1) { try { nameJson = decodeURIComponent(generatedUri.substring(hashIdxJson + 1)); } catch (e) {} }
                                                var existsJ = false;
                                                for (var jj = 0; jj < validLinks.length; jj++) { if (validLinks[jj].link === generatedUri) { existsJ = true; break; } }
                                                if (!existsJ) validLinks.push({ name: nameJson, link: generatedUri });
                                                if (validLinks.length >= 1000) break;
                                            }
                                        }
                                        if (validLinks.length > 0) isJsonProcessed = true;
                                    }
                                } catch (jsonErr) {}
                            }

                            if (!isJsonProcessed && validLinks.length === 0) {
                                var decoded = text;

                                if (text.indexOf('://') === -1 && text.indexOf('{') === -1 && text.indexOf('[Interface]') === -1) {
                                    var cleanBase64 = text.replace(/[\r\n\s]/g, '').replace(/-/g, '+').replace(/_/g, '/');
                                    while (cleanBase64.length % 4 !== 0) cleanBase64 += '=';
                                    var tempDecoded = decodeBase64(cleanBase64);
                                    if (tempDecoded) decoded = tempDecoded;
                                }

                                var regex = /(vless|trojan|ss|socks5):\/\/[^\r\n"'<>]+/gi;
                                var matches = decoded.match(regex);
                                if (!matches) matches = text.match(regex);

                                if (matches) {
                                    for (var mi = 0; mi < matches.length; mi++) {
                                        var line = matches[mi].trim();
                                        var name = 'Сервер ' + (validLinks.length + 1);
                                        var hashIdx = line.indexOf('#');
                                        if (hashIdx !== -1) { try { name = decodeURIComponent(line.substring(hashIdx + 1)); } catch (e) {} }
                                        var exists = false;
                                        for (var mj = 0; mj < validLinks.length; mj++) { if (validLinks[mj].link === line) { exists = true; break; } }
                                        if (!exists) validLinks.push({ name: name, link: line });
                                        if (validLinks.length >= 1000) break;
                                    }
                                } else if (text.indexOf('[Interface]') !== -1 && text.indexOf('[Peer]') !== -1) {
                                    var existsAWG = false;
                                    for (var w = 0; w < validLinks.length; w++) { if (validLinks[w].link === text) { existsAWG = true; break; } }
                                    if (!existsAWG) validLinks.push({ name: 'AmneziaWG Сервер', link: text });
                                }
                            }

                            if (validLinks.length > 0) {
                                var updatedCount = 0;

                                for (var ui = 0; ui < linkHistory.length; ui++) {
                                    var oldUrl = linkHistory[ui].link;
                                    var oldName = '';
                                    var lastHash = oldUrl.lastIndexOf('#');

                                    if (lastHash !== -1) {
                                        try { oldName = decodeURIComponent(oldUrl.substring(lastHash + 1)); }
                                        catch (e) { oldName = oldUrl.substring(lastHash + 1); }
                                    }

                                    if (!oldName) continue;

                                    for (var vi = 0; vi < validLinks.length; vi++) {
                                        if (validLinks[vi].name === oldName) {
                                            if (oldUrl !== validLinks[vi].link) {
                                                linkHistory[ui].link = validLinks[vi].link;
                                                updatedCount++;

                                                if (currentLink === oldUrl) {
                                                    currentLink = validLinks[vi].link;
                                                    try { fs.writeFileSync(LINK_FILE, currentLink); } catch (e) {}
                                                }
                                            }
                                            break;
                                        }
                                    }
                                }

                                if (updatedCount > 0) {
                                    try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(linkHistory)); } catch (e) {}
                                }

                                sendJson(res, 200, { success: true, links: validLinks });
                            } else {
                                var snippet2 = (typeof text === 'string') ? text.substring(0, 80) : '';
                                sendParseError(res, 'Серверы не найдены. Сниппет: ' + snippet2);
                            }
                        } catch (e) {
                            sendParseError(res, 'Ошибка обработки: ' + e.message);
                        }
                    }

                    if (data.url) {
                        var subUrl = data.url;
                        if (!subUrl || (subUrl.indexOf('http://') !== 0 && subUrl.indexOf('https://') !== 0)) {
                            sendParseError(res, 'Неверный формат ссылки URL'); return;
                        }

                        if (subUrl.indexOf('hwid=') === -1) {
                            subUrl += (subUrl.indexOf('?') !== -1 ? '&' : '?') + 'hwid=' + encodeURIComponent(deviceHwid);
                        }

                        function fetchCurl(targetUrl, cb) {
                            execFile(
                                MODERN_CURL,
                                ['-s', '-L', '-k', '--connect-timeout', '5', '--max-time', '15', '-A', 'Happ/3.26.2', '-H', 'X-HWID: ' + deviceHwid, targetUrl],
                                { timeout: 20000, maxBuffer: 5242880 },
                                function(error, stdout, stderr) {
                                    if (error) return cb((stderr || error.message).trim());
                                    if (!stdout) return cb('Пустой ответ');
                                    cb(null, stdout);
                                }
                            );
                        }

                        function fetchNative(currentUrl, redirectCount, cb, cookies) {
                            if (redirectCount > 8) return cb('Цикл перенаправлений.');

                            var finished = false;
                            function safeCb(err, result) {
                                if (finished) return;
                                finished = true;
                                cb(err, result);
                            }

                            var parsedUrl = urlModule.parse(currentUrl);
                            var client = parsedUrl.protocol === 'https:' ? https : http;

                            var reqHeaders = {
                                'User-Agent': 'Happ/3.26.2',
                                'Accept': 'application/json, text/plain, */*',
                                'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
                                'Accept-Encoding': 'gzip, deflate',
                                'X-HWID': deviceHwid,
                                'Host': parsedUrl.hostname
                            };

                            if (cookies) reqHeaders['Cookie'] = cookies;

                            var options = {
                                hostname: parsedUrl.hostname,
                                port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
                                path: parsedUrl.path,
                                method: 'GET',
                                headers: reqHeaders,
                                rejectUnauthorized: false,
                                servername: parsedUrl.hostname
                            };

                            var subReq = client.request(options, function(subRes) {
                                var newCookies = cookies || '';
                                if (subRes.headers['set-cookie']) {
                                    var cList = subRes.headers['set-cookie'];
                                    newCookies = Array.isArray(cList) ? cList.map(function(c) { return c.split(';')[0]; }).join('; ') : cList.split(';')[0];
                                }

                                if (subRes.statusCode >= 300 && subRes.statusCode < 400 && subRes.headers.location) {
                                    var redirectUrl = subRes.headers.location;

                                    if (redirectUrl.indexOf('happ://') === 0) {
                                        try {
                                            var parsedHapp = urlModule.parse(redirectUrl, true);
                                            if (parsedHapp.query && parsedHapp.query.url) {
                                                redirectUrl = parsedHapp.query.url;
                                            } else {
                                                var matchUrl = redirectUrl.match(/https?:\/\/[^\s]+/i);
                                                if (matchUrl) redirectUrl = matchUrl[0];
                                            }
                                        } catch (e) {}
                                    }

                                    if (redirectUrl.indexOf('http://') !== 0 && redirectUrl.indexOf('https://') !== 0) {
                                        redirectUrl = urlModule.resolve(currentUrl, redirectUrl);
                                    }
                                    subRes.resume();
                                    return fetchNative(redirectUrl, redirectCount + 1, safeCb, newCookies);
                                }

                                var stream = subRes;
                                if (subRes.headers['content-encoding'] === 'gzip') {
                                    stream = subRes.pipe(zlib.createGunzip());
                                } else if (subRes.headers['content-encoding'] === 'deflate') {
                                    stream = subRes.pipe(zlib.createInflate());
                                }

                                if (stream !== subRes) {
                                    subRes.on('error', function(resErr) {
                                        safeCb('Ошибка потока HTTP: ' + resErr.message);
                                    });
                                }

                                var subData = '';
                                var tooLarge = false;
                                stream.on('data', function(chunk) {
                                    if (tooLarge) return;
                                    subData += chunk;
                                    if (subData.length > 1000000) {
                                        tooLarge = true;
                                        subReq.abort();
                                        safeCb('Ответ сервера слишком большой (>1MB)');
                                    }
                                });

                                stream.on('error', function(streamErr) {
                                    subReq.abort();
                                    safeCb('Ошибка чтения ответа: ' + streamErr.message);
                                });

                                stream.on('end', function() {
                                    if (tooLarge) return;
                                    if (subRes.statusCode !== 200) return safeCb('Ошибка HTTP ' + subRes.statusCode);
                                    safeCb(null, subData);
                                });
                            });

                            subReq.on('error', function(err) { safeCb('Сбой сети HTTP: ' + err.message); });
                            subReq.setTimeout(10000, function() { subReq.abort(); safeCb('Таймаут соединения'); });
                            subReq.end();
                        }

                        fetchCurl(subUrl, function(errCurl, textCurl) {
                            var isHtml = false;
                            if (textCurl) {
                                var cText = textCurl.trim().toLowerCase();
                                if (cText.indexOf('<') === 0 || cText.indexOf('<!doctype') === 0) isHtml = true;
                            }

                            if (errCurl || isHtml || !textCurl) {
                                fetchNative(subUrl, 0, function(errNat, textNat) {
                                    if (errNat) {
                                        sendParseError(res, 'Обе попытки провалились!\nCURL: ' + (errCurl || 'Блок HTML') + '\nNATIVE: ' + errNat);
                                        return;
                                    }
                                    processText(textNat);
                                });
                                return;
                            }

                            processText(textCurl);
                        });
                    } else if (data.text) {
                        processText(data.text);
                    } else {
                        sendParseError(res, 'Нет данных для парсинга');
                    }
                } catch (e) { sendParseError(res, 'Системная ошибка JSON: ' + e.message); }
            });
            return;
        }

        if (req.method === 'POST' && req.url === '/send-link') {
            var bodySend = ''; req.on('data', function(c) { bodySend += c; });
            req.on('end', function() {
                try {
                    var data = JSON.parse(bodySend);
                    if (!data.link) throw new Error('No link');

                    var inputStr = data.link.trim();

                    if (inputStr.indexOf('{') === 0) {
                        try {
                            var parsedJson = JSON.parse(inputStr);
                            var converted = convertJsonToUri(parsedJson);
                            if (converted) { data.link = converted; }
                            else { return sendJson(res, 400, { success: false, error: 'invalid_json_config' }); }
                        } catch (err) { return sendJson(res, 400, { success: false, error: 'invalid_json_format' }); }
                    } else {
                        data.link = inputStr;
                    }

                    var existingIdx = findLinkIndex(data.link);
                    if (existingIdx === -1) {
                        if (linkHistory.length >= 8) {
                            var removed = false;
                            for (var ri = linkHistory.length - 1; ri >= 0; ri--) { if (!linkHistory[ri].fav) { linkHistory.splice(ri, 1); removed = true; break; } }
                            if (!removed) { return sendJson(res, 400, { success: false, error: 'limit_fav' }); }
                        }
                        var insertIdx = 0; while (insertIdx < linkHistory.length && linkHistory[insertIdx].fav) insertIdx++;
                        linkHistory.splice(insertIdx, 0, { link: data.link, fav: false });
                    } else {
                        var item = linkHistory.splice(existingIdx, 1)[0];
                        if (item.fav) linkHistory.unshift(item);
                        else { var insertIdx2 = 0; while (insertIdx2 < linkHistory.length && linkHistory[insertIdx2].fav) insertIdx2++; linkHistory.splice(insertIdx2, 0, item); }
                    }

                    hasLink = true; currentLink = data.link;
                    fs.writeFileSync(LINK_FILE, currentLink); fs.writeFileSync(HISTORY_FILE, JSON.stringify(linkHistory));
                    sendJson(res, 200, { success: true });
                } catch (e) { sendJson(res, 400, { success: false }); }
            });
            return;
        }

        if (req.method === 'POST' && req.url === '/set-link') {
            var bodySet = ''; req.on('data', function(c) { bodySet += c; });
            req.on('end', function() {
                try {
                    var data = JSON.parse(bodySet);
                    if (data.link && findLinkIndex(data.link) !== -1) { currentLink = data.link; hasLink = true; fs.writeFileSync(LINK_FILE, currentLink); }
                    sendJson(res, 200, { success: true });
                } catch (e) { sendJson(res, 400, { success: false }); }
            });
            return;
        }

        if (req.method === 'POST' && req.url === '/delete-link') {
            var bodyDel = ''; req.on('data', function(c) { bodyDel += c; });
            req.on('end', function() {
                try {
                    var data = JSON.parse(bodyDel);
                    var idx = findLinkIndex(data.link);
                    if (idx !== -1) {
                        linkHistory.splice(idx, 1);
                        fs.writeFileSync(HISTORY_FILE, JSON.stringify(linkHistory));
                        if (currentLink === data.link) {
                            currentLink = linkHistory.length > 0 ? linkHistory[0].link : '';
                            if (!currentLink) hasLink = false;
                            if (currentLink) fs.writeFileSync(LINK_FILE, currentLink);
                            else try { fs.unlinkSync(LINK_FILE); } catch (e) {}
                        }
                    }
                    sendJson(res, 200, { success: true });
                } catch (e) { sendJson(res, 400, { success: false }); }
            });
            return;
        }

        if (req.method === 'POST' && req.url === '/clear-history') {
            var keepFavs = [];
            for (var ci = 0; ci < linkHistory.length; ci++) { if (linkHistory[ci].fav) keepFavs.push(linkHistory[ci]); }
            linkHistory = keepFavs;

            var foundCurrent = false;
            for (var cj = 0; cj < linkHistory.length; cj++) { if (linkHistory[cj].link === currentLink) { foundCurrent = true; break; } }

            if (!foundCurrent) {
                currentLink = linkHistory.length > 0 ? linkHistory[0].link : '';
                if (!currentLink) {
                    hasLink = false;
                    try { fs.unlinkSync(LINK_FILE); } catch (e) {}
                    try { fs.unlinkSync(CONFIG_PATH); } catch (e) {}
                } else { fs.writeFileSync(LINK_FILE, currentLink); }
            }

            fs.writeFileSync(HISTORY_FILE, JSON.stringify(linkHistory));
            sendJson(res, 200, { success: true });
            return;
        }

        if (req.method === 'POST' && req.url === '/toggle-fav') {
            var bodyFav = ''; req.on('data', function(c) { bodyFav += c; });
            req.on('end', function() {
                try {
                    var data = JSON.parse(bodyFav);
                    var idx = findLinkIndex(data.link);
                    if (idx !== -1) {
                        var isNowFav = !linkHistory[idx].fav;
                        var item = linkHistory.splice(idx, 1)[0];
                        item.fav = isNowFav;

                        if (isNowFav) linkHistory.unshift(item);
                        else {
                            var insertIdx = 0;
                            while (insertIdx < linkHistory.length && linkHistory[insertIdx].fav) insertIdx++;
                            linkHistory.splice(insertIdx, 0, item);
                        }
                        fs.writeFileSync(HISTORY_FILE, JSON.stringify(linkHistory));
                        sendJson(res, 200, { success: true, fav: item.fav });
                    } else { sendJson(res, 400, { success: false, error: 'not_found' }); }
                } catch (e) { sendJson(res, 400, { success: false }); }
            });
            return;
        }

        if (req.method === 'POST' && req.url === '/get-start-cmds') {
            var body2 = ''; req.on('data', function(c) { body2 += c; });
            req.on('end', function() {
                try {
                    var data = JSON.parse(body2 || '{}');
                    prepareStartScript(data.link || currentLink, function(err, command) {
                        if (err) return sendJson(res, 400, { success: false, error: err.message });
                        sendJson(res, 200, { success: true, command: command });
                    });
                } catch (e) { sendJson(res, 400, { success: false, error: e.message }); }
            });
            return;
        }

        if (req.method === 'POST' && req.url === '/start-vpn') {
            if (isBusy) return sendJson(res, 400, { success: false, error: 'Операция уже выполняется' });
            isBusy = true;
            prepareStartScript(currentLink, function(err, cmd) {
                if (err) { isBusy = false; return sendJson(res, 400, { success: false, error: err.message }); }
                execRoot(cmd, function(execErr) {
                    isBusy = false;
                    if (!execErr && !fs.existsSync(RUN_FLAG)) {
                        execErr = new Error('Ядро не запустилось. Откройте диагностику.');
                    }
                    if (execErr) return sendJson(res, 400, { success: false, error: execErr.message });
                    sendJson(res, 200, { success: true });
                });
            });
            return;
        }

        // === БЫСТРАЯ ОСТАНОВКА ЧЕРЕЗ WATCHDOG (1-2 сек) + РЕЗЕРВ ЧЕРЕЗ ROOT ===
        if (req.method === 'POST' && (req.url === '/stop-vpn' || req.url === '/kill-vpn')) {
            if (isBusy) return sendJson(res, 400, { success: false, error: 'Операция уже выполняется' });
            isBusy = true;

            function runFallbackStop() {
                var stopCmd = buildStopCommand(true);
                try {
                    fs.writeFileSync(STOP_SCRIPT, '#!/bin/sh\n' + stopCmd + '\n');
                    try { fs.chmodSync(STOP_SCRIPT, 493); } catch (ce) {}
                    stopCmd = 'sh ' + STOP_SCRIPT;
                } catch (e) {}
                execRoot(stopCmd, function(execErr) {
                    isBusy = false;
                    if (execErr) return sendJson(res, 400, { success: false, error: execErr.message });
                    sendJson(res, 200, { success: true });
                }, 15000);
            }

            // Пытаемся остановить через уже запущенный от root watchdog (без вызова luna-send-pub)
            var dieWritten = false;
            if (fs.existsSync(RUN_FLAG)) {
                try {
                    fs.writeFileSync(DIE_FLAG, '1');
                    dieWritten = true;
                } catch (e) {}
            }

            if (!dieWritten) {
                return runFallbackStop();
            }

            var waitTicks = 0;
            var waitTimer = setInterval(function() {
                waitTicks++;
                if (!fs.existsSync(RUN_FLAG)) {
                    clearInterval(waitTimer);
                    isBusy = false;
                    return sendJson(res, 200, { success: true });
                }
                if (waitTicks >= 16) { // 4 секунды
                    clearInterval(waitTimer);
                    runFallbackStop();
                }
            }, 250);
            return;
        }

        if (req.method === 'POST' && req.url === '/clear-action') {
            pendingAction = '';
            sendJson(res, 200, { success: true });
            return;
        }

        if (req.method === 'POST' && req.url === '/ping-server') {
            var bodyPing = ''; req.on('data', function(c) { bodyPing += c; });
            req.on('end', function() {
                try {
                    var data = JSON.parse(bodyPing);
                    var link = data.link;
                    if (!link) return sendJson(res, 400, { success: false, error: 'No link' });
                    var outbound = UniversalParser(link);
                    if (!outbound || !outbound.server) return sendJson(res, 400, { success: false, error: 'Parse error' });

                    var host = outbound.server; var port = outbound.server_port || 443;
                    var startTime = Date.now(); var socket = new net.Socket(); var finished = false;

                    socket.setTimeout(2500);
                    socket.on('connect', function() {
                        if (finished) return; finished = true;
                        var duration = Date.now() - startTime;
                        socket.destroy();
                        sendJson(res, 200, { success: true, ping: duration });
                    });
                    socket.on('timeout', function() {
                        if (finished) return; finished = true;
                        socket.destroy();
                        sendJson(res, 200, { success: false, error: 'Timeout' });
                    });
                    socket.on('error', function() {
                        if (finished) return; finished = true;
                        socket.destroy();
                        sendJson(res, 200, { success: false, error: 'Error' });
                    });
                    socket.connect(port, host);
                } catch (e) { sendJson(res, 400, { success: false, error: 'Catch error' }); }
            });
            return;
        }

        if (req.method === 'GET' && req.url === '/run-diagnostics') {
            var diagCmds = [
                'echo \'--- STARTUP LOG ---\'',
                'tail -n 25 ' + START_LOG + ' 2>/dev/null || echo \'No log\'',
                'echo \'\'',
                'echo \'--- XRAY LOG ---\'',
                'tail -n 35 ' + RUNTIME_PATH + '/xray.log 2>/dev/null | grep -v \'│\' | grep -v \'─\' | grep -v \'┌\' | grep -v \'└\' || echo \'No log\''
            ].join(' ; ');

            exec(diagCmds, function(error, stdout, stderr) {
                var output = (stdout || '').trim();
                if (stderr) output += '\nERRORS:\n' + stderr.trim();
                if (!output) output = 'Нет данных для отображения';

                var pingDone = false;
                function finishDiag(pingStatus) {
                    if (pingDone) return;
                    pingDone = true;
                    output += '\n\n--- GOOGLE PING ---\n' + pingStatus;
                    sendJson(res, 200, { success: true, log: output });
                }

                var pingStart = Date.now();
                var checkReq = https.request({
                    hostname: 'www.google.com',
                    port: 443,
                    path: '/generate_204',
                    method: 'GET',
                    rejectUnauthorized: false
                }, function(checkRes) {
                    checkRes.resume();
                    var ms = Date.now() - pingStart;
                    finishDiag('Connect OK (HTTP ' + checkRes.statusCode + ', ' + ms + ' ms)');
                });
                checkReq.setTimeout(8000, function() {
                    checkReq.abort();
                    finishDiag('Connection timeout (8s)');
                });
                checkReq.on('error', function(reqErr) {
                    finishDiag('Connection error: ' + reqErr.message);
                });
                checkReq.end();
            });
            return;
        }

        res.writeHead(404); res.end('Not found');
    });

    server.listen(8888, '0.0.0.0', function() {});
}

// СТАРТ СЛУЖБЫ
ensureStorageAndStart(initAndListen);