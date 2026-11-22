var API_URL = 'http://127.0.0.1:8888';

var btnToggle = document.getElementById('btnToggle');
var btnCaption = document.querySelector('.button-caption');
var connectionStatus = document.getElementById('connectionStatus');
var ipSpan = document.getElementById('ip-address');
var linkStatusSpan = document.getElementById('linkStatus');
var toastEl = document.getElementById('toast');
var serverItems = document.querySelectorAll('.server-item');
var btnClear = document.querySelector('.clear-history');
var debugConsole = document.getElementById('debugConsole');

var statusDot = document.getElementById('status-dot');
var statusText = document.getElementById('status-text');
var qrContainer = document.getElementById('qr-container');

var autostartToggle = document.getElementById('autostartToggle');
var isAutostartProcessing = false;

var isRunning = false;
var hasLink = false;
var currentLink = '';
var serviceStarted = false;
var lastDrawnIp = '';

var isCheckingStatus = false;

var buttons = [];
var currentFocusIndex = 0;

function logToScreen(text, isError) {
    if (!debugConsole) return;
    var time = new Date().toLocaleTimeString();
    var prefix = isError ? 'ERR: ' : 'LOG: ';
    var color = isError ? '#ff6b6b' : '#3dd9b8';
    var span = document.createElement('span');
    span.style.color = color;
    span.textContent = '[' + time + '] ' + prefix + text + '\n';
    debugConsole.insertBefore(span, debugConsole.firstChild);
}

window.lunaBridges = [];
function createLunaBridge() {
    if (window.PalmServiceBridge) {
        var bridge = new PalmServiceBridge();
        window.lunaBridges.push(bridge);
        if (window.lunaBridges.length > 5) window.lunaBridges.shift();
        return bridge;
    }
    return null;
}

function wakeUpService() {
    return new Promise(function(resolve) {
        if (serviceStarted) return resolve();
        fetch(API_URL + '/status')
            .then(function() { serviceStarted = true; resolve(); })
            .catch(function() {
                var bridge = createLunaBridge();
                if (bridge) bridge.call('luna://com.proxytune.service/ping', '{}');
                setTimeout(function() { serviceStarted = true; resolve(); }, 1500);
            });
    });
}

function showToast(msg, type) {
    type = type || 'info';
    toastEl.textContent = msg;
    toastEl.className = 'toast ' + type + ' show';
    clearTimeout(toastEl._timeout);
    toastEl._timeout = setTimeout(function() { toastEl.className = 'toast'; }, 5000);
}

function apiCall(endpoint, method, body) {
    method = method || 'GET';
    return new Promise(function(resolve, reject) {
        wakeUpService().then(function() {
            var options = { method: method };
            if (body) {
                options.headers = { 'Content-Type': 'application/json' };
                options.body = JSON.stringify(body);
            }
            fetch(API_URL + endpoint, options)
                .then(function(res) { return res.json(); })
                .then(function(data) { resolve(data); })
                .catch(function(e) { reject(e); });
        });
    });
}

function formatLinkName(url, customName) {
    try {
        if (!url) return 'Пусто';
        var cleanUrl = url.trim();

        if (cleanUrl.indexOf('{') === 0) return '[JSON] Конфиг';

        if (cleanUrl.indexOf('[Interface]') !== -1) {
            var matchEndpoint = cleanUrl.match(/Endpoint\s*=\s*([a-zA-Z0-9\.\-\:]+)/i);
            var endpointStr = matchEndpoint ? matchEndpoint[1] : 'Неизвестный сервер';
            var matchKey = cleanUrl.match(/PublicKey\s*=\s*([A-Za-z0-9\+\/]{4})/i);
            var shortKey = matchKey ? matchKey[1] : '???';
            return 'AWG [' + shortKey + '] ' + endpointStr;
        }

        if (customName && customName !== cleanUrl && customName !== 'AmneziaWG Сервер') return customName;

        var hashIndex = cleanUrl.lastIndexOf('#');
        if (hashIndex !== -1) {
            var name = cleanUrl.substring(hashIndex + 1);
            try { name = decodeURIComponent(name); } catch (e) {}
            if (name.length > 45) name = name.substring(0, 45) + '...';
            return name;
        }

        var parts = cleanUrl.split('://');
        if (parts.length < 2) {
            var shortStr = cleanUrl.replace(/\n/g, ' ');
            return shortStr.substring(0, 25) + '...';
        }

        var protocol = parts[0].toLowerCase() + '://';
        var rest = parts[1].split('?')[0];
        if (rest.indexOf('@') !== -1) {
            var authSplit = rest.split('@');
            rest = authSplit[authSplit.length - 1];
        }
        rest = rest.split('/')[0];
        return protocol + rest;
    } catch (e) {
        var fallback = (url || '').replace(/\n/g, ' ');
        return fallback ? fallback.substring(0, 25) + '...' : 'Пусто';
    }
}

function startVPN() {
    if (!currentLink) { showToast('Отправьте ссылку с телефона', 'error'); return; }

    if (btnCaption) btnCaption.textContent = 'Запуск...';
    btnToggle.disabled = true;
    logToScreen('Запускаем VPN через сервис...', false);

    apiCall('/start-vpn', 'POST')
        .then(function(data) {
            btnToggle.disabled = false;
            if (data && data.success) {
                isRunning = true;
                showToast('VPN запущен!', 'success');
                logToScreen('VPN успешно запущен', false);
            } else {
                isRunning = false;
                var errMsg = (data && data.error) ? data.error : 'Ошибка запуска';
                showToast(errMsg, 'error');
                logToScreen(errMsg, true);
            }
            updateUI();
        })
        .catch(function() {
            btnToggle.disabled = false;
            isRunning = false;
            showToast('Сервер недоступен', 'error');
            updateUI();
        });
}

function stopVPN() {
    if (btnCaption) btnCaption.textContent = 'Остановка...';
    btnToggle.disabled = true;

    apiCall('/kill-vpn', 'POST')
        .then(function(data) {
            btnToggle.disabled = false;
            if (data && data.success) {
                isRunning = false;
                showToast('VPN отключен', 'info');
            } else {
                showToast((data && data.error) ? data.error : 'Ошибка остановки', 'error');
            }
            updateUI();
        })
        .catch(function() {
            btnToggle.disabled = false;
            showToast('Сервер недоступен', 'error');
            updateUI();
        });
}

function toggleVPN() {
    if (isRunning) stopVPN(); else startVPN();
}

function updateUI() {
    if (connectionStatus) {
        connectionStatus.textContent = isRunning ? 'Защищено' : 'Отключено';
        connectionStatus.className = 'status-badge ' + (isRunning ? 'connected' : 'disconnected');
    }

    if (statusDot && statusText) {
        if (isRunning) {
            statusDot.className = 'status-dot dot-green';
            statusText.className = 'status-text text-green';
            statusText.innerText = 'Активно';
        } else {
            statusDot.className = 'status-dot dot-red';
            statusText.className = 'status-text text-red';
            statusText.innerText = 'Остановлен';
        }
    }

    if (!btnToggle.disabled) { if (btnCaption) btnCaption.textContent = ''; }
    if (isRunning) { btnToggle.classList.add('active'); } else { btnToggle.classList.remove('active'); }
    if (linkStatusSpan) {
        var activeItem = linkHistoryCache.find(function(i) { return i.link === currentLink; });
        var customName = activeItem ? activeItem.name : null;
        linkStatusSpan.textContent = hasLink ? formatLinkName(currentLink, customName) : 'Нет';
        linkStatusSpan.className = 'value' + (hasLink ? '' : ' off');
    }
}

var linkHistoryCache = [];

function checkLinkStatus() {
    if (isCheckingStatus) return;
    isCheckingStatus = true;

    apiCall('/status')
        .then(function(data) {
            isCheckingStatus = false;
            if (data.hasLink) { hasLink = true; if (data.link) currentLink = data.link; }
            else { hasLink = false; currentLink = ''; }

            if (autostartToggle && typeof data.autostart !== 'undefined' && !isAutostartProcessing) {
                if (autostartToggle.checked !== data.autostart) {
                    autostartToggle.checked = data.autostart;
                }
            }

            var autostartBlock = document.querySelector('.autostart-header-block');
            if (autostartToggle && autostartBlock) {
                if (data.running) {
                    autostartToggle.disabled = true;
                    autostartBlock.style.opacity = '0.4';
                    autostartBlock.style.pointerEvents = 'none';
                } else {
                    autostartToggle.disabled = false;
                    autostartBlock.style.opacity = '1';
                    autostartBlock.style.pointerEvents = 'auto';
                }
            }

            if (data.pendingAction) {
                apiCall('/clear-action', 'POST');
            }

            if (!btnToggle.disabled && data.running !== isRunning) {
                isRunning = data.running;
            }

            if (data.ip) {
                var localUrl = 'http://' + data.ip + ':8888';
                if (ipSpan) ipSpan.textContent = localUrl;

                if (qrContainer) {
                    var qrBox = document.getElementById('qrcode-box');
                    if (qrBox && lastDrawnIp !== data.ip) {
                        qrBox.innerHTML = '';
                        new QRCode(qrBox, {
                            text: localUrl, width: 110, height: 110,
                            colorDark: '#000000', colorLight: '#ffffff',
                            correctLevel: QRCode.CorrectLevel.L
                        });
                        lastDrawnIp = data.ip;
                    }
                    qrContainer.style.display = 'block';
                }
            } else {
                lastDrawnIp = '';
                if (ipSpan) ipSpan.textContent = 'Нет сети';
                if (qrContainer) qrContainer.style.display = 'none';
            }

            if (data.history && serverItems) {
                linkHistoryCache = data.history;
                buttons = [btnToggle];

                if (autostartToggle && !autostartToggle.disabled) {
                    buttons.push(autostartToggle);
                }

                var hasAnyLink = data.history.length > 0;

                for (var i = 0; i < 8; i++) {
                    var item = serverItems[i]; if (!item) continue;

                    if (data.history[i]) {
                        var historyObj = data.history[i];
                        var linkText = typeof historyObj === 'object' ? historyObj.link : historyObj;
                        var isFav = typeof historyObj === 'object' ? historyObj.fav : false;
                        var customName = typeof historyObj === 'object' ? historyObj.name : null;

                        var displayName = formatLinkName(linkText, customName);
                        if (isFav) displayName = '⭐ ' + displayName;
                        item.textContent = displayName;
                        item.dataset.link = linkText;
                        item.className = 'server-item' + (linkText === currentLink ? ' active' : '');
                        item.style.cursor = 'pointer';
                        item.style.display = '';
                        buttons.push(item);
                    } else {
                        if (i === 0 && !hasAnyLink) {
                            item.textContent = 'Ожидание конфигурации...';
                            item.className = 'server-item';
                            item.style.cursor = 'default';
                            delete item.dataset.link;
                            item.style.display = '';
                        } else {
                            item.style.display = 'none';
                            delete item.dataset.link;
                        }
                    }
                }

                if (btnClear) {
                    if (hasAnyLink) {
                        btnClear.style.display = ''; buttons.push(btnClear);
                    } else {
                        btnClear.style.display = 'none';
                    }
                }
                if (currentFocusIndex >= buttons.length) setFocus(0);
            }
            updateUI();
        })
        .catch(function() {
            isCheckingStatus = false;
        });
}

function setFocus(index) {
    if (buttons.length === 0) return;
    for (var i = 0; i < buttons.length; i++) {
        if (buttons[i]) buttons[i].blur();
    }
    currentFocusIndex = (index + buttons.length) % buttons.length;
    if (buttons[currentFocusIndex]) {
        buttons[currentFocusIndex].focus();
    }
}

if (serverItems) {
    for (var i = 0; i < serverItems.length; i++) {
        (function(index) {
            var item = serverItems[index]; if (!item) return; item.tabIndex = 0;

            item.addEventListener('click', function() {
                if (btnToggle.disabled) return;

                var clickedLink = item.dataset.link;
                if (!clickedLink) return;

                if (isRunning) {
                    if (clickedLink === currentLink) {
                        stopVPN();
                    } else {
                        btnToggle.disabled = true;
                        apiCall('/set-link', 'POST', { link: clickedLink }).then(function() {
                            currentLink = clickedLink;
                            stopVPN();
                        });
                    }
                } else {
                    if (clickedLink === currentLink) {
                        startVPN();
                    } else {
                        btnToggle.disabled = true;
                        apiCall('/set-link', 'POST', { link: clickedLink }).then(function() {
                            showToast('Сервер выбран! Нажмите еще раз для запуска.', 'success');
                            currentLink = clickedLink;
                            btnToggle.disabled = false;
                            checkLinkStatus();
                        });
                    }
                }
            });
            item.addEventListener('keydown', function(e) { if (e.key === 'Enter') item.click(); });
        })(i);
    }
}

if (btnClear) {
    btnClear.tabIndex = 0;
    btnClear.addEventListener('click', function() {
        if (btnToggle.disabled) return;
        if (isRunning) { showToast('Остановите VPN перед очисткой', 'error'); return; }
        apiCall('/clear-history', 'POST').then(function() { showToast('История очищена', 'info'); checkLinkStatus(); });
    });
    btnClear.addEventListener('keydown', function(e) { if (e.key === 'Enter') btnClear.click(); });
}

if (autostartToggle) {
    autostartToggle.tabIndex = 0;

    function processToggleAction(isEnabled) {
        if (isAutostartProcessing) return;
        isAutostartProcessing = true;

        apiCall('/toggle-autostart', 'POST', { enable: isEnabled })
            .then(function(data) {
                isAutostartProcessing = false;
                if (data && data.success) {
                    showToast(data.enabled ? 'Автозапуск Включен' : 'Автозапуск Отключен', 'success');
                } else {
                    autostartToggle.checked = !isEnabled;
                    showToast((data && data.error) ? data.error : 'Ошибка применения Root-прав', 'error');
                }
            })
            .catch(function() {
                isAutostartProcessing = false;
                autostartToggle.checked = !isEnabled;
                showToast('Ошибка связи с сервером', 'error');
            });
    }

    autostartToggle.addEventListener('change', function(e) {
        if (isAutostartProcessing) {
            e.preventDefault();
            autostartToggle.checked = !e.target.checked;
            return;
        }
        processToggleAction(e.target.checked);
    });

    autostartToggle.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();

            if (isAutostartProcessing) return;

            autostartToggle.checked = !autostartToggle.checked;
            processToggleAction(autostartToggle.checked);
        }
    });
}

document.addEventListener('keydown', function(e) {
    switch (e.key) {
        case 'ArrowUp':
        case 'ArrowLeft':
            e.preventDefault(); setFocus(currentFocusIndex - 1); break;
        case 'ArrowDown':
        case 'ArrowRight':
            e.preventDefault(); setFocus(currentFocusIndex + 1); break;
        case 'Enter':
            e.preventDefault();
            if (buttons[currentFocusIndex]) buttons[currentFocusIndex].click();
            break;
    }
});

document.addEventListener('DOMContentLoaded', function() {
    buttons = [btnToggle];
    if (autostartToggle) buttons.push(autostartToggle);

    updateUI();
    setFocus(0);
    if (btnToggle) btnToggle.addEventListener('click', toggleVPN);

    wakeUpService().then(function() {
        checkLinkStatus();

        if (autostartToggle) {
            apiCall('/autostart-status').then(function(data) {
                autostartToggle.checked = data.enabled;
            }).catch(function() {});
        }

        setInterval(checkLinkStatus, 1000);
    });
});