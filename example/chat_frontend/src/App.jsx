import {useEffect, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {canisterId as chatCanisterId, createActor as createChatActor} from 'declarations/chat_backend';
import {HttpAgent} from '@dfinity/agent';
import {Ed25519KeyIdentity} from '@dfinity/identity';
import './index.scss';
import LoadingButton from './components/LoadingButton';
import icWebPush from 'ic-web-push';

const LAST_URL_KEY = 'chat.pwa.lastUrl';
const LAST_URL_TS_KEY = 'chat.pwa.lastUrl.ts';
const RESTORED_FLAG = 'chat.pwa.restoredOnce';
const SKIP_RESTORE_FLAG = 'chat.pwa.skipRestoreOnce';
const SESSION_TIMEOUT_MS = 24 * 60 * 60 * 1000; // Keep in sync with backend

// Temporary suppression timestamp for URL saves (e.g., during notification-driven nav)
let saveSuppressUntil = 0;

// Shared handler to process OPEN_URL messages from the Service Worker (and other sources)
function handleOpenUrlFromMessage(url) {
    try {
        const target = new URL(url, window.location.origin);
        if (target.origin !== window.location.origin) return;
        if (window.location.href === target.href) {
            return;
        }
        // Mark that this session should skip PWA restore logic
        try {
            sessionStorage.setItem(SKIP_RESTORE_FLAG, '1');
            sessionStorage.setItem(RESTORED_FLAG, '1');
        } catch (_) {
        }
        // Remove masking if present
        try {
            document.body?.classList?.remove('pwa-restoring');
        } catch (_) {
        }
        // Temporarily suppress last-URL saves during the transition
        try {
            saveSuppressUntil = Date.now() + 2000;
        } catch (_) {
        }
        // Navigate so initial URL parsing logic runs (joins by path-based room id)
        window.location.href = target.href;
    } catch (_) {
    }
}

// Early listener (module-scope) to catch messages even before React mounts
function onSwMessage(event) {
    try {
        const data = event?.data || {};
        if (data?.type === 'OPEN_URL' && data?.url) {
            handleOpenUrlFromMessage(data.url);
        }
    } catch (_) {
    }
}

try {
    if (typeof window !== 'undefined') {
        if (navigator?.serviceWorker) {
            try {
                navigator.serviceWorker.addEventListener('message', onSwMessage);
            } catch (_) {
            }
        }
        try {
            window.addEventListener('message', onSwMessage);
        } catch (_) {
        }
    }
} catch (_) {
}

function saveLastUrl() {
    try {
        const url = new URL(window.location.href);
        if (url.origin !== window.location.origin) return;
        localStorage.setItem(LAST_URL_KEY, url.href);
        localStorage.setItem(LAST_URL_TS_KEY, String(Date.now()));
    } catch (_) {
    }
}

function readValidLastUrl() {
    try {
        const href = localStorage.getItem(LAST_URL_KEY);
        if (!href) return null;
        const tsStr = localStorage.getItem(LAST_URL_TS_KEY) || '';
        const ts = Number(tsStr);
        if (Number.isFinite(ts) && ts > 0) {
            if (Date.now() - ts > SESSION_TIMEOUT_MS) {
                try {
                    localStorage.removeItem(LAST_URL_KEY);
                    localStorage.removeItem(LAST_URL_TS_KEY);
                } catch (_) {
                }
                return null;
            }
        }
        let url = new URL(href, window.location.origin);
        const refID = url.searchParams.get('refID') || url.searchParams.get('room') || url.searchParams.get('code');
        if (refID && /^[A-Za-z0-9]{6}$/.test(refID)) {
            const normalized = new URL('/' + String(refID).toUpperCase(), window.location.origin);
            return normalized.href;
        }
        return url.href;
    } catch (_) {
        return null;
    }
}

(function preMarkForPwaRestore() {
    try {
        if (typeof window === 'undefined' || typeof document === 'undefined') return;
        const mm = (q) => window.matchMedia && window.matchMedia(q).matches;
        const isStandalone = (mm('(display-mode: standalone)') || mm('(display-mode: minimal-ui)') || mm('(display-mode: fullscreen)')) ||
            (typeof navigator !== 'undefined' && 'standalone' in navigator && navigator.standalone === true);
        if (!isStandalone) return;
        try {
            if (sessionStorage.getItem(SKIP_RESTORE_FLAG) === '1') return;
        } catch (_) {
        }
        const current = new URL(window.location.href);
        const atRoot = current.pathname === '/' && current.search === '' && current.hash === '';
        if (!atRoot) return;
        const lastHref = readValidLastUrl();
        if (!lastHref) return;
        const target = new URL(lastHref, window.location.origin);
        if (target.origin !== window.location.origin) return;
        if (target.href === current.href) return;
        document.body && document.body.classList && document.body.classList.add('pwa-restoring');
        setTimeout(() => {
            try {
                document.body.classList.remove('pwa-restoring');
            } catch (_) {
            }
        }, 4000);
    } catch (_) {
    }
})();

function installLocationTracker() {
    try {
        const isStandalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
            (typeof navigator !== 'undefined' && 'standalone' in navigator && navigator.standalone === true);
        const current = new URL(window.location.href);
        const atRoot = current.pathname === '/' && current.search === '' && current.hash === '';
        const existing = localStorage.getItem(LAST_URL_KEY);
        let suppressSaves = !!(isStandalone && atRoot && existing);
        const suppressTimer = setTimeout(() => {
            suppressSaves = false;
        }, 2000);
        const maybeSave = () => {
            if (suppressSaves) return;
            if (Date.now() < saveSuppressUntil) return;
            try {
                saveLastUrl();
            } catch (_) {
            }
        };
        if (!suppressSaves) {
            try {
                saveLastUrl();
            } catch (_) {
            }
        }
        const onChange = () => {
            maybeSave();
        };
        window.addEventListener('popstate', onChange);
        window.addEventListener('hashchange', onChange);
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') onChange();
        });
        const origPush = window.history.pushState.bind(window.history);
        const origReplace = window.history.replaceState.bind(window.history);
        window.history.pushState = function (...args) {
            const ret = origPush(...args);
            maybeSave();
            return ret;
        };
        window.history.replaceState = function (...args) {
            const ret = origReplace(...args);
            maybeSave();
            return ret;
        };
        const beforeUnload = () => {
            try {
                const nowUrl = new URL(window.location.href);
                const atRootNow = nowUrl.pathname === '/' && nowUrl.search === '' && nowUrl.hash === '';
                if (!atRootNow) saveLastUrl();
            } catch (_) {
            }
        };
        window.addEventListener('beforeunload', beforeUnload);
        return () => {
            clearTimeout(suppressTimer);
            window.removeEventListener('popstate', onChange);
            window.removeEventListener('hashchange', onChange);
            window.removeEventListener('beforeunload', beforeUnload);
        };
    } catch (_) {
        return () => {
        };
    }
}

const ID_STORAGE_KEY_V2 = 'chat.identity.v2';
const ID_STORAGE_SOURCE_KEY = 'chat.identity.source';

// Simple IndexedDB helpers
function openIdb() {
    return new Promise((resolve, reject) => {
        if (!('indexedDB' in window)) return resolve(null);
        const req = indexedDB.open('chat-idb', 1);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
    });
}

function idbGet(db, key) {
    return new Promise((resolve) => {
        if (!db) return resolve(null);
        const tx = db.transaction('kv', 'readonly');
        const store = tx.objectStore('kv');
        const req = store.get(key);
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror = () => resolve(null);
    });
}

function idbSet(db, key, value) {
    return new Promise((resolve) => {
        if (!db) return resolve(false);
        const tx = db.transaction('kv', 'readwrite');
        const store = tx.objectStore('kv');
        const req = store.put(value, key);
        req.onsuccess = () => resolve(true);
        req.onerror = () => resolve(false);
    });
}

async function getOrCreateIdentity(setDiag) {
    let lastError = '';

    const b64ToUint8 = (b64) => {
        try {
            const clean = String(b64).replace(/\s+/g, '');
            const bin = atob(clean);
            const arr = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
            return arr;
        } catch (e) {
            throw new Error('invalid base64');
        }
    };

    try {
        const storedV2 = localStorage.getItem(ID_STORAGE_KEY_V2);
        if (storedV2) {
            const parsed = JSON.parse(storedV2);
            if (parsed && parsed.v === 2 && parsed.type === 'ed25519' && parsed.sk) {
                const id = Ed25519KeyIdentity.fromSecretKey(b64ToUint8(parsed.sk));
                try {
                    localStorage.setItem(ID_STORAGE_SOURCE_KEY, 'localStorage(v2)');
                } catch (_) {
                }
                if (setDiag) setDiag({source: 'localStorage(v2)', error: ''});
                return id;
            }
        }
    } catch (e) {
        lastError = 'localStorage v2 read failed: ' + (e?.message || String(e));
    }

    try {
        const db = await openIdb();
        const stored = await idbGet(db, ID_STORAGE_KEY_V2);
        if (stored) {
            const parsed = typeof stored === 'string' ? JSON.parse(stored) : stored;
            if (parsed && parsed.v === 2 && parsed.type === 'ed25519' && parsed.sk) {
                const id = Ed25519KeyIdentity.fromSecretKey(b64ToUint8(parsed.sk));
                // Repair localStorage with V2
                try {
                    localStorage.setItem(ID_STORAGE_KEY_V2, JSON.stringify(parsed));
                } catch (_) {
                }
                try {
                    localStorage.setItem(ID_STORAGE_SOURCE_KEY, 'indexedDB(v2)');
                } catch (_) {
                }
                if (setDiag) setDiag({source: 'indexedDB(v2)', error: ''});
                return id;
            }
        }
    } catch (e) {
        lastError = (lastError ? lastError + ' | ' : '') + 'indexedDB v2 read failed: ' + (e?.message || String(e));
    }


    const identity = Ed25519KeyIdentity.generate();
    const skArr = Array.from(identity.getKeyPair().secretKey);
    let skBin = '';
    for (let i = 0; i < skArr.length; i++) skBin += String.fromCharCode(skArr[i]);
    const v2wrapper = {v: 2, type: 'ed25519', sk: btoa(skBin)};
    try {
        localStorage.setItem(ID_STORAGE_KEY_V2, JSON.stringify(v2wrapper));
        localStorage.setItem(ID_STORAGE_SOURCE_KEY, 'generated(v2)');
    } catch (e) {
        lastError = (lastError ? lastError + ' | ' : '') + 'localStorage v2 write failed: ' + (e?.message || String(e));
    }
    try {
        const db = await openIdb();
        await idbSet(db, ID_STORAGE_KEY_V2, JSON.stringify(v2wrapper));
    } catch (e) {
        lastError = (lastError ? lastError + ' | ' : '') + 'indexedDB v2 write failed: ' + (e?.message || String(e));
    }
    if (setDiag) setDiag({source: 'generated(v2)', error: lastError});
    return identity;
}

function applyMessagesFlickeringGuard(prev, nextList) {
    if (!Array.isArray(nextList)) return prev;
    if (!Array.isArray(prev)) return nextList;
    if (nextList.length < prev.length) return prev;
    if (nextList.length === prev.length && prev.length > 0) {
        const prevLast = prev[prev.length - 1] || {};
        const nextLast = nextList[nextList.length - 1] || {};
        const prevLastId = prevLast.id;
        const nextLastId = nextLast.id;
        if (prevLastId != null && nextLastId != null && prevLastId === nextLastId) {
            // Identical tail, treat as no-op to avoid re-renders that may retrigger scroll logic
            return prev;
        }
        const prevLastTs = Number(prevLast?.timestamp || 0);
        const nextLastTs = Number(nextLast?.timestamp || 0);
        if (nextLastTs < prevLastTs) return prev;
    }
    return nextList;
}

function App() {
    const [agent, setAgent] = useState(null);
    const [chatActor, setChatActor] = useState(null);
    const chatActorRef = useRef(null);
    const pendingJoinRef = useRef('');
    const [currentView, setCurrentView] = useState('home'); // 'home', 'room', 'join'
    const [roomCode, setRoomCode] = useState('');
    const currentRoomRef = useRef('');
    const [joinCode, setJoinCode] = useState('');
    const [messages, setMessages] = useState([]);
    const [newMessage, setNewMessage] = useState('');
    const [room, setRoom] = useState(null);
    const [error, setError] = useState('');
    const [isCreator, setIsCreator] = useState(false);
    const [copySuccess, setCopySuccess] = useState(false);
    const messagesEndRef = useRef(null);
    const [remainingMs, setRemainingMs] = useState(null);
    const [isExpired, setIsExpired] = useState(false);
    const [showExpiredModal, setShowExpiredModal] = useState(false);
    // Loading states
    const [isCreating, setIsCreating] = useState(false);
    const [isJoining, setIsJoining] = useState(false);
    const [isSending, setIsSending] = useState(false);

    // Previously joined room codes
    const [myCodes, setMyCodes] = useState([]);
    const [loadingMyCodes, setLoadingMyCodes] = useState(false);

    const [myPrincipal, setMyPrincipal] = useState('');
    const [isSubscribed, setIsSubscribed] = useState(false);
    const [localNotifError, setLocalNotifError] = useState(null);
    const [isNotifWorking, setIsNotifWorking] = useState(false);
    const [mobileNonPwa, setMobileNonPwa] = useState(false);

    // Scroll management
    const messagesContainerRef = useRef(null);
    const lastMessageIdRef = useRef(null);
    const sendByMeRef = useRef(false);
    // Force a one-time scroll when entering the chat view
    const forceScrollOnEnterRef = useRef(false);
    // Tracks whether user interacted with the list (e.g., scrolled)
    const userInteractedRef = useRef(false);
    // Track previous messages length to detect appends even if IDs are odd
    const prevLenRef = useRef(0);
    // Track whether the user is at/near the bottom; helps decide auto-scroll on new messages
    const stuckToBottomRef = useRef(true);
    // Track last known near-bottom state to detect transitions
    const lastNearBottomRef = useRef(true);

    const clearNotificationsByTag = async (tag) => {
        try {
            if (!tag) return;
            if (navigator?.serviceWorker) {
                try {
                    const regs = await navigator.serviceWorker.getRegistrations();
                    regs?.forEach(reg => {
                        try { reg?.active?.postMessage({ type: 'CLEAR_NOTIFICATIONS_BY_TAG', tag }); } catch (_) {}
                    });
                } catch (_) {}
                try {
                    navigator.serviceWorker.controller?.postMessage({ type: 'CLEAR_NOTIFICATIONS_BY_TAG', tag });
                } catch (_) {}
            }
        } catch (_) {}
    };

    const isNearBottom = (el, threshold = 160) => {
        if (!el) return true;
        try {
            const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
            return distance <= threshold;
        } catch (_) {
            return true;
        }
    };

    useEffect(() => {
        const container = messagesContainerRef.current;
        const lastId = messages?.length ? messages[messages.length - 1]?.id : null;
        const prevLast = lastMessageIdRef.current;
        const nearBottom = isNearBottom(container, 160);
        const hasNew = !!(lastId && lastId !== prevLast);
        const allowForce = !!(forceScrollOnEnterRef.current && !userInteractedRef.current);

        // detect appends by length (covers cases where IDs are new but also when ids behave unexpectedly)
        const len = Array.isArray(messages) ? messages.length : 0;
        const prevLen = prevLenRef.current || 0;
        const appended = len > prevLen;
        prevLenRef.current = len;

        // remember the latest id
        lastMessageIdRef.current = lastId;

        // keep a sticky "at bottom" state to handle async rendering
        if (container) {
            stuckToBottomRef.current = isNearBottom(container, 160);
        }

        // Decide if we should auto-scroll now
        const shouldScroll = (
            sendByMeRef.current ||
            // New/append and user is/was at bottom (or force on enter)
            ((hasNew || appended) && (nearBottom || stuckToBottomRef.current || allowForce)) ||
            // Force on entry
            allowForce
        );

        if (shouldScroll) {
            requestAnimationFrame(() => {
                messagesEndRef.current?.scrollIntoView({behavior: sendByMeRef.current ? 'smooth' : 'auto'});
                try {
                    if (currentView === 'room' && currentRoomRef.current) {
                        clearNotificationsByTag(currentRoomRef.current).then();
                    }
                } catch (_) {}
            });
            // reset the one-time enter flag after we acted on it
            forceScrollOnEnterRef.current = false;
        }
        sendByMeRef.current = false;
    }, [messages]);

    // One-time scroll when entering the chat view from other screens
    useEffect(() => {
        let clearTimer = null;
        if (currentView === 'room') {
            // reset interaction state on enter
            userInteractedRef.current = false;
            // set the flag so the messages effect also respects it
            forceScrollOnEnterRef.current = true;
            requestAnimationFrame(() => {
                messagesEndRef.current?.scrollIntoView({behavior: 'auto'});
                try {
                    if (currentRoomRef.current) {
                        clearNotificationsByTag(currentRoomRef.current).then();
                    }
                } catch (_) {}
            });
            // safety: clear the force flag shortly after mount to avoid late auto-scroll
            clearTimer = setTimeout(() => {
                forceScrollOnEnterRef.current = false;
            }, 600);
        }
        return () => {
            if (clearTimer) clearTimeout(clearTimer);
        };
    }, [currentView]);

    // Track user scroll interaction to disable forced auto-scroll once the user scrolls away
    useEffect(() => {
        if (currentView !== 'room') return;
        const el = messagesContainerRef.current;
        if (!el) return;
        const onScroll = () => {
            userInteractedRef.current = true;
            const near = isNearBottom(el, 80);
            const wasNear = !!lastNearBottomRef.current;
            lastNearBottomRef.current = near;
            if (!near) {
                // as soon as the user scrolls away from bottom, cancel any pending forced scroll
                forceScrollOnEnterRef.current = false;
            } else if (!wasNear && near) {
                try {
                    if (currentView === 'room' && currentRoomRef.current) {
                        clearNotificationsByTag(currentRoomRef.current).then();
                    }
                } catch (_) {}
            }
        };
        el.addEventListener('scroll', onScroll, {passive: true});
        return () => {
            el.removeEventListener('scroll', onScroll);
        };
    }, [currentView]);

    useEffect(() => {
        (async () => {
            try {
                const identity = await getOrCreateIdentity();
                try {
                    setMyPrincipal(identity.getPrincipal().toText());
                } catch (_) {
                    // ignore
                }
                const agent = new HttpAgent({identity});
                if (import.meta && import.meta.env && import.meta.env.MODE !== 'production') {
                    try {
                        await agent.fetchRootKey();
                    } catch (e) {
                        console.warn('fetchRootKey failed', e);
                    }
                } else if (typeof process !== 'undefined' && process.env && process.env.DFX_NETWORK !== 'ic') {
                    try {
                        await agent.fetchRootKey();
                    } catch (e) {
                        console.warn('fetchRootKey failed', e);
                    }
                }
                setAgent(agent);
                const ca = createChatActor(chatCanisterId, {agent});
                chatActorRef.current = ca;
                setChatActor(ca);
                refreshMyCodes().then();
                try {
                    const ua = navigator.userAgent || '';
                    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua) ||
                        // iPadOS 13+ may report as Mac, use touch points heuristic
                        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
                    const isStandalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
                        (typeof navigator !== 'undefined' && 'standalone' in navigator && navigator.standalone === true);
                    const mobileNotPwa = !!isMobile && !isStandalone;
                    setMobileNonPwa(mobileNotPwa);
                    if (mobileNotPwa) {
                        setLocalNotifError('In order to get working push notifications on mobile, open this app as PWA');
                    } else {
                        icWebPush.setDebug(true);
                        // icWebPush.setDebugAlerts(true);
                        setIsNotifWorking(true);
                        icWebPush.init({
                            applicationCanisterId: chatCanisterId, agent, serviceWorkerPath: '/sw.js'
                        });
                        icWebPush.ensureSubscribed({requestPermissionIfNeeded: true})
                            .catch((err) => {
                                console.error(err);
                                setIsSubscribed(false);
                                setLocalNotifError('"ensureSubscribed" failed: ' + (err?.message || String(err)));
                            })
                            .finally(async () => {
                                try {
                                    const sub = await icWebPush.isSubscribed();
                                    setIsSubscribed(!!sub);
                                } catch (_) {
                                } finally {
                                    setIsNotifWorking(false);
                                }
                            });
                    }
                } catch (_) {
                    // ignore
                }
            } catch (e) {
                console.error('Failed to init identity/actor', e);
                setIsNotifWorking(false);
            }
        })();
    }, []);

    // Install URL tracker to remember last visited in-app URL for PWA restore
    useEffect(() => {
        const cleanup = installLocationTracker();
        return () => {
            try {
                cleanup && cleanup();
            } catch (_) {
            }
        };
    }, []);

    // Restore last URL when opening as PWA (standalone) if available
    useEffect(() => {
        try {
            const isStandalone = (window.matchMedia && (window.matchMedia('(display-mode: standalone)').matches ||
                    window.matchMedia('(display-mode: minimal-ui)').matches ||
                    window.matchMedia('(display-mode: fullscreen)').matches)) ||
                (typeof navigator !== 'undefined' && 'standalone' in navigator && navigator.standalone === true);
            if (!isStandalone) return;
            // Avoid re-restoring in same session
            if (sessionStorage.getItem(RESTORED_FLAG) === '1') return;
            // If a notification intent is present, skip restore
            if (sessionStorage.getItem(SKIP_RESTORE_FLAG) === '1') return;

            const current = new URL(window.location.href);
            const atRoot = current.pathname === '/' && current.search === '' && current.hash === '';
            if (!atRoot) return;

            const lastHref = readValidLastUrl();
            if (!lastHref) return;
            let target;
            try {
                target = new URL(lastHref, window.location.origin);
            } catch {
                return;
            }
            // Only restore for same-origin and when different from current
            const sameOrigin = target.origin === window.location.origin;
            const different = target.href !== current.href;
            if (sameOrigin && different) {
                sessionStorage.setItem(RESTORED_FLAG, '1');
                window.location.replace(target.href);
            }
        } catch (_) {
            // ignore
        }
    }, []);

    // Request persistent storage (helps Safari/iOS and desktop not evict data)
    useEffect(() => {
        (async () => {
            if (navigator.storage?.persist) {
                try {
                    await navigator.storage.persist();
                } catch (_) {
                }
            }
        })();
        return () => {
        };
    }, []);

    // Listen for messages from Service Worker (e.g., OPEN_URL from notificationclick)
    useEffect(() => {
        if (navigator?.serviceWorker) {
            navigator.serviceWorker.addEventListener('message', onSwMessage);
        }
        return () => {
            if (navigator?.serviceWorker) {
                navigator.serviceWorker.removeEventListener('message', onSwMessage);
            }
        };
    }, []);

    async function refreshIsSubscribed() {
        try {
            const sub = await icWebPush.isSubscribed();
            setIsSubscribed(!!sub);
        } catch (_) {
        }
    }

    async function handleSubscribe() {
        setLocalNotifError(null);
        setIsNotifWorking(true);
        try {
            await icWebPush.subscribe({requestPermissionIfNeeded: true});
        } catch (e) {
            console.error('Subscribe failed: ' + (e?.message || String(e)));
            setLocalNotifError('Subscribe failed: ' + (e?.message || String(e)));
        } finally {
            await refreshIsSubscribed();
            setIsNotifWorking(false);
        }
    }

    async function handleUnsubscribe() {
        setIsNotifWorking(true);
        try {
            await icWebPush.unsubscribe();
        } catch (e) {
            console.error('Unsubscribe failed: ' + (e?.message || String(e)));
            // Not treating as an error for the label; state will reflect after refresh
        } finally {
            await refreshIsSubscribed();
            setIsNotifWorking(false);
        }
    }

    async function findIcWebPushRegistration() {
        try {
            if (!('serviceWorker' in navigator)) return null;
            // Try current scope first
            if (navigator.serviceWorker.getRegistration) {
                const reg = await navigator.serviceWorker.getRegistration();
                if (reg && (reg?.active?.scriptURL?.includes('ic-web-push-sw.js') || reg?.scope?.endsWith('/ic-web-push/'))) {
                    return reg;
                }
            }
            // Fallback: scan all registrations
            if (navigator.serviceWorker.getRegistrations) {
                const regs = await navigator.serviceWorker.getRegistrations();
                const match = regs.find(r => r?.active?.scriptURL?.includes('ic-web-push-sw.js') || r?.scope?.endsWith('/ic-web-push/'));
                if (match) return match;
            }
        } catch (_) {
        }
        return null;
    }

    async function testLocalNotification() {
        setLocalNotifError(null);
        try {
            const reg = await findIcWebPushRegistration();
            if (!reg) {
                setLocalNotifError('Service worker not ready');
                return;
            }
            if (!isSubscribed) {
                // Button is disabled in this case, but keep a guard
                setLocalNotifError('Permission not granted');
                return;
            }
            await reg.showNotification('Local test', {body: 'If you see this, notifications are allowed.'});
            // Success: leave error as null so the area remains hidden
        } catch (e) {
            setLocalNotifError('Local notification failed: ' + (e?.message || String(e)));
        }
    }

    // Helper: extract a 6-char room code from current URL (path or legacy query)
    function getRoomCodeFromLocation() {
        try {
            const url = new URL(window.location.href);
            // Prefer path segment
            const segments = (url.pathname || '/').split('/').filter(Boolean);
            const last = segments.length > 0 ? segments[segments.length - 1] : '';
            let candidate = String(last || '').toUpperCase();
            if (!/^[A-Z0-9]{6}$/.test(candidate)) {
                // Legacy query params fallback
                const ref = url.searchParams.get('refID') || url.searchParams.get('room') || url.searchParams.get('code') || '';
                candidate = String(ref || '').toUpperCase();
            }
            return /^[A-Z0-9]{6}$/.test(candidate) ? candidate : '';
        } catch (_) {
            return '';
        }
    }

    // Ensure UI joins the room indicated by URL if different from current state (idempotent, no flicker)
    const ensureRoomFromPath = () => {
        try {
            const candidate = getRoomCodeFromLocation();
            if (!candidate) return;

            // Compare strictly against current in-memory state; do not rely on session snapshot
            const currentRoomUpper = (roomCode || '').toUpperCase();
            const isSameRoom = !!currentRoomUpper && currentRoomUpper === candidate;

            if (isSameRoom) {
                // Already in this room. Avoid any joins. Optionally switch view if we truly have a joined room.
                try {
                    saveSuppressUntil = Date.now() + 1200;
                } catch (_) {
                }
                if (currentView !== 'room' && roomCode) {
                    // Only switch to room view if a real room is active in state
                    setCurrentView('room');
                }
                return;
            }

            // Different target room from URL or we are not joined yet → perform a silent join
            setJoinCode(candidate);
            if (chatActorRef.current) {
                handleJoinRoom(candidate, {silent: true});
            } else {
                // Defer until actor is ready
                pendingJoinRef.current = candidate;
            }
        } catch (_) {
        }
    };

    // On mount, reconcile path -> room and subscribe to URL/visibility changes
    useEffect(() => {
        // If we land with a room code in the URL, suppress internal URL writes briefly
        try {
            const code = getRoomCodeFromLocation();
            if (code) {
                saveSuppressUntil = Date.now() + 2000;
            }
        } catch (_) {
        }

        ensureRoomFromPath();

        const onPop = () => {
            try {
                ensureRoomFromPath();
            } catch (_) {
            }
        };
        const onHash = () => {
            try {
                ensureRoomFromPath();
            } catch (_) {
            }
        };
        let visTimer = null;
        const onVis = () => {
            try {
                if (document.visibilityState === 'visible') {
                    if (visTimer) clearTimeout(visTimer);
                    visTimer = setTimeout(() => {
                        try {
                            ensureRoomFromPath();
                        } catch (_) {
                        }
                    }, 200);
                }
            } catch (_) {
            }
        };

        window.addEventListener('popstate', onPop);
        window.addEventListener('hashchange', onHash);
        document.addEventListener('visibilitychange', onVis);
        return () => {
            window.removeEventListener('popstate', onPop);
            window.removeEventListener('hashchange', onHash);
            document.removeEventListener('visibilitychange', onVis);
            if (visTimer) clearTimeout(visTimer);
        };
    }, []);

    // When backend actor becomes ready, perform any pending auto-join
    useEffect(() => {
        if (chatActorRef.current && pendingJoinRef.current) {
            const code = pendingJoinRef.current;
            pendingJoinRef.current = '';
            handleJoinRoom(code, {silent: true});
        }
    }, [chatActor]);

    // Update URL when room code changes (only if it doesn't already match)
    useEffect(() => {
        if (!roomCode || currentView !== 'room') return;
        // Avoid clobbering URL during external/navigation-driven transitions
        if (Date.now() < saveSuppressUntil) return;
        const path = window.location.pathname || '/';
        const segs = path.split('/').filter(Boolean);
        const last = segs.length > 0 ? String(segs[segs.length - 1]).toUpperCase() : '';
        if (last === String(roomCode).toUpperCase()) return; // already matches target room
        if (segs.length && /^[A-Z0-9]{6}$/.test(last)) {
            segs.pop(); // remove previous roomId segment
        }
        const basePath = segs.length ? ('/' + segs.join('/')) : '';
        const newUrl = `${window.location.origin}${basePath}/${roomCode}`;
        window.history.pushState({}, '', newUrl);
    }, [roomCode, currentView]);

    // Keep isCreator in sync with current room and my principal
    useEffect(() => {
        try {
            if (room && myPrincipal) {
                const creatorText = principalToText(room.creator);
                setIsCreator(creatorText === myPrincipal);
            } else {
                setIsCreator(false);
            }
        } catch (_) {
            setIsCreator(false);
        }
    }, [room, myPrincipal]);

    // Mirror current room into a ref and sessionStorage to avoid re-joining on resume
    useEffect(() => {
        const upper = (roomCode || '').toUpperCase();
        currentRoomRef.current = upper;
        try {
            sessionStorage.setItem('chat.currentRoom', upper);
        } catch (_) {
        }
    }, [roomCode]);

    // Poll for new messages every 2 seconds
    useEffect(() => {
        if (currentView === 'room' && roomCode) {
            const interval = setInterval(async () => {
                try {
                    if (!chatActorRef.current) return;
                    const roomMessages = await chatActorRef.current.getMessages(roomCode);
                    setMessages(prev => applyMessagesFlickeringGuard(prev, roomMessages));
                } catch (err) {
                    console.error('Error fetching messages:', err);
                }
            }, 2000);

            return () => clearInterval(interval);
        }
    }, [currentView, roomCode]);

    // Poll room metadata (lastActivity) periodically to drive timer
    useEffect(() => {
        if (currentView === 'room' && roomCode) {
            const interval = setInterval(async () => {
                try {
                    if (!chatActorRef.current) return;
                    const result = await chatActorRef.current.getRoom(roomCode);
                    if (Array.isArray(result) && result.length > 0) {
                        setRoom(result[0]);
                    } else {
                        // Room no longer exists (ended or expired)
                        setIsExpired(true);
                        setShowExpiredModal(true);
                    }
                } catch (err) {
                    console.error('Error fetching room:', err);
                }
            }, 5000);

            return () => clearInterval(interval);
        }
    }, [currentView, roomCode]);

    // periodically clear notifications for the current chat, to handle delayed push arrivals
    useEffect(() => {
        if (currentView !== 'room' || !roomCode) return;
        let intervalId = null;
        const run = () => {
            try {
                if (document.visibilityState !== 'visible') return;
                const tag = currentRoomRef.current;
                if (tag) {
                    clearNotificationsByTag(tag).then();
                }
            } catch (_) {}
        };
        const setup = () => {
            try {
                if (document.visibilityState === 'visible') {
                    run();
                    if (!intervalId) {
                        intervalId = setInterval(run, 5000);
                    }
                } else {
                    if (intervalId) {
                        clearInterval(intervalId);
                        intervalId = null;
                    }
                }
            } catch (_) {}
        };
        setup();
        const onVis = () => setup();
        document.addEventListener('visibilitychange', onVis);
        return () => {
            if (intervalId) clearInterval(intervalId);
            document.removeEventListener('visibilitychange', onVis);
        };
    }, [currentView, roomCode]);

    // Compute countdown every second from room.lastActivity
    useEffect(() => {
        if (currentView !== 'room') return;
        const tick = () => {
            if (!room?.lastActivity) return;
            const lastActivityMs = Number(room.lastActivity) / 1_000_000; // backend uses ns
            const elapsed = Date.now() - lastActivityMs;
            const remaining = SESSION_TIMEOUT_MS - elapsed;
            setRemainingMs(Math.max(remaining, 0));
            const expiredNow = remaining <= 0;
            setIsExpired(expiredNow);
            if (expiredNow) setShowExpiredModal(true);
        };
        tick();
        const interval = setInterval(tick, 1000);
        return () => clearInterval(interval);
    }, [currentView, room]);


    const handleCreateRoom = async () => {
        if (isCreating) return;
        setIsCreating(true);
        try {
            setError('');
            if (!chatActorRef.current) throw new Error('Actor not ready');
            const result = await chatActorRef.current.createRoom();

            if ('Ok' in result) {
                setRoomCode(result.Ok.roomCode);
                setRoom(result.Ok.room);
                setMessages(result.Ok.room.messages);
                const creatorText = principalToText(result.Ok.room.creator);
                setIsCreator(creatorText === myPrincipal);
                setCurrentView('room');
                // Ensure we scroll to bottom upon entering the chat view
                forceScrollOnEnterRef.current = true;
                setShowExpiredModal(false);
                setIsExpired(false);
            } else {
                setError(result.Err);
            }
        } catch (err) {
            setError('Failed to create room: ' + err.message);
        } finally {
            setIsCreating(false);
        }
    };

    const handleEndRoom = async () => {
        if (!isCreator) return;
        const confirmEnd = window.confirm('End room for all participants? This cannot be undone.');
        if (!confirmEnd) return;
        try {
            if (!chatActorRef.current) throw new Error('Actor not ready');
            const ok = await chatActorRef.current.endRoom(roomCode);
            if (ok) {
                setShowExpiredModal(true);
                setIsExpired(true);
            } else {
                setError('Failed to end room.');
            }
        } catch (err) {
            setError('Failed to end room: ' + err.message);
        }
    };

    const handleJoinRoom = async (codeArg = null, options = {silent: false}) => {
        if (isJoining) return;
        setIsJoining(true);
        const codeRaw = (typeof codeArg === 'string' && codeArg ? codeArg : joinCode).trim().toUpperCase();
        if (!codeRaw) {
            if (!options?.silent) setError('Please enter a room code');
            setIsJoining(false);
            return;
        }
        if (codeRaw.length !== 6) {
            if (!options?.silent) setError('Room code must be 6 characters');
            setIsJoining(false);
            return;
        }

        try {
            if (!options?.silent) setError('');
            if (!chatActorRef.current) throw new Error('Actor not ready');
            let result = await chatActorRef.current.getJoinedRoom(codeRaw);
            if ('Err' in result) {
                if (result.Err === "Not joined") {
                    result = await chatActorRef.current.joinRoom(codeRaw);
                } else if (result.Err === "Room has expired") {
                    chatActorRef.current.joinRoom(codeRaw).then(); // make canister clean up the room
                }
            }
            if ('Ok' in result) {
                setRoomCode(codeRaw);
                setRoom(result.Ok.room);
                setMessages(result.Ok.room.messages);
                const creatorText = principalToText(result.Ok.room.creator);
                setIsCreator(creatorText === myPrincipal);
                setCurrentView('room');
                // Ensure we scroll to bottom upon entering the chat view
                forceScrollOnEnterRef.current = true;
                setShowExpiredModal(false);
                setIsExpired(false);
                refreshMyCodes().then();
            } else {
                setError(result.Err);
            }
        } catch (err) {
            setError('Failed to join room: ' + err.message);
        } finally {
            setIsJoining(false);
        }
    };

    const handleSendMessage = async (e) => {
        // Mark that the next scroll should be smooth and forced (message sent by me)
        sendByMeRef.current = true;
        e.preventDefault();
        if (isSending) return;
        if (!newMessage.trim() || isExpired) return;
        setIsSending(true);

        try {
            if (!chatActorRef.current) throw new Error('Actor not ready');
            const result = await chatActorRef.current.sendMessage(roomCode, newMessage.trim());

            if ('Ok' in result) {
                try {
                    const roomMessages = await chatActorRef.current.getMessages(roomCode);
                    setMessages(prev => applyMessagesFlickeringGuard(prev, roomMessages));
                } catch (_) {
                    setMessages(prev => {
                        const exists = prev?.some?.(m => m?.id === result.Ok?.id);
                        return exists ? prev : [...prev, result.Ok];
                    });
                }
                setNewMessage('');
            } else {
                setError(result.Err);
            }
        } catch (err) {
            setError('Failed to send message: ' + err.message);
        } finally {
            setIsSending(false);
        }
    };

    const refreshMyCodes = async () => {
        if (!chatActorRef.current) return;
        try {
            setLoadingMyCodes(true);
            const codes = await chatActorRef.current.myRoomCodes();
            setMyCodes(Array.isArray(codes) ? codes : []);
        } catch (e) {
            console.warn('refresh myRoomCodes failed', e);
        } finally {
            setLoadingMyCodes(false);
        }
    };

    useEffect(() => {
        if (currentView === 'join' && chatActorRef.current) {
            refreshMyCodes().catch(() => {
            });
        }
    }, [currentView]);

    const handleLeaveRoom = async () => {
        if (chatActorRef.current) {
            chatActorRef.current.leaveRoom(roomCode).catch(err => console.error('Error leaving room:', err));
        } else {
            console.error('Actor not ready');
        }
        setCurrentView('home');
        setRoomCode('');
        setRoom(null);
        setMessages([]);
        setNewMessage('');
        setError('');
        // Ensure URL shows root path
        try {
            window.history.replaceState({}, '', '/');
        } catch (_) {
            window.location.hash = '#';
        }
        refreshMyCodes().catch(() => {
        });
    };

    const handleBackToJoin = () => {
        setCurrentView('join');
        // Ensure URL shows root path when navigating back from chat view
        try {
            window.history.replaceState({}, '', '/');
        } catch (_) {
            window.location.hash = '#';
        }
    };

    const handleCopyRoomCode = async () => {
        try {
            const path = window.location.pathname || '/';
            const segs = path.split('/').filter(Boolean);
            if (segs.length && /^[A-Z0-9]{6}$/.test(String(segs[segs.length - 1]).toUpperCase())) {
                segs.pop(); // strip existing room id if present
            }
            const basePath = segs.length ? ('/' + segs.join('/')) : '';
            const roomUrl = `${window.location.origin}${basePath}/${roomCode}`;
            await navigator.clipboard.writeText(roomUrl);
            setCopySuccess(true);
            setTimeout(() => setCopySuccess(false), 2000);
        } catch (err) {
            // Fallback for older browsers
            const path = window.location.pathname || '/';
            const segs = path.split('/').filter(Boolean);
            if (segs.length && /^[A-Z0-9]{6}$/.test(String(segs[segs.length - 1]).toUpperCase())) {
                segs.pop();
            }
            const basePath = segs.length ? ('/' + segs.join('/')) : '';
            const fallbackUrl = `${window.location.origin}${basePath}/${roomCode}`;
            const textArea = document.createElement('textarea');
            textArea.value = fallbackUrl;
            document.body.appendChild(textArea);
            textArea.select();
            document.execCommand('copy');
            document.body.removeChild(textArea);
            setCopySuccess(true);
            setTimeout(() => setCopySuccess(false), 2000);
        }
    };

    const formatTime = (timestamp) => {
        const date = new Date(Number(timestamp) / 1000000);
        return date.toLocaleTimeString();
    };

    const principalToText = (p) => {
        try {
            return p && typeof p.toText === 'function' ? p.toText() : String(p);
        } catch (_) {
            return String(p);
        }
    };

    const formatMessageSender = (message) => {
        // Show "You" for current user, display name for others
        return principalToText(message.sender) === myPrincipal ? "You" : message.senderName;
    };

    if (currentView === 'home') {
        return (<div className="app">
            <div className="container">
                <h1>canChat</h1>
                <p>Create or join a chat room</p>

                {error && <div className="error">{error}</div>}

                <div className="button-group">
                    <LoadingButton onClick={handleCreateRoom} className="btn btn-primary" isLoading={isCreating}>
                        Create Room
                    </LoadingButton>
                    <button onClick={() => setCurrentView('join')} className="btn btn-secondary">
                        Join Room
                    </button>
                </div>

                {/* PWA / Notifications panel */}
                <div className="pwa-panel"
                     style={{marginTop: '24px', padding: '12px', border: '1px solid #333', borderRadius: '8px'}}>
                    <div>My principal: {myPrincipal || 'unknown'}</div>
                    {isNotifWorking ? (
                        <div className="button-group" style={{marginTop: '12px'}}>
                            <button className="btn btn-secondary" disabled>
                                <span className="spinner" aria-hidden="true"/>
                                Processing...
                            </button>
                        </div>
                    ) : !mobileNonPwa && (
                        <div className="button-group" style={{marginTop: '12px'}}>
                            <button
                                onClick={handleSubscribe}
                                className="btn btn-secondary"
                                disabled={isSubscribed}
                                title="Enable notifications (required on iOS via a user tap)"
                            >
                                {isSubscribed ? 'Notifications enabled' : 'Enable notifications'}
                            </button>
                            <button
                                onClick={handleUnsubscribe}
                                className="btn btn-warning"
                                disabled={!isSubscribed}
                                title="Disable notifications and unregister on server"
                            >
                                Disable notifications
                            </button>
                            <button
                                onClick={testLocalNotification}
                                className="btn"
                                disabled={!isSubscribed}
                                title="Show a local test notification"
                            >
                                Test local notification
                            </button>
                        </div>
                    )}
                    {(mobileNonPwa || localNotifError) && (
                        <div className="error" style={{marginTop: '8px'}}>{localNotifError}</div>
                    )}
                    <div style={{marginTop: '8px', fontSize: '0.9em', opacity: 0.8}}>
                        Tip: On iOS, install from Safari via Share → Add to Home Screen, then open the app icon and
                        tap “Enable notifications”.
                    </div>
                </div>
            </div>
        </div>);
    }

    if (currentView === 'join') {
        return (<div className="app">
            <div className="container join-container">
                <h1>Join Room</h1>
                <p>Enter the 6-character room code</p>

                {error && <div className="error">{error}</div>}

                <div className="input-group">
                    <input
                        type="text"
                        value={joinCode}
                        onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                        placeholder="Enter room code"
                        maxLength="6"
                        className="room-code-input"
                    />
                    <LoadingButton onClick={handleJoinRoom} className="btn btn-primary" isLoading={isJoining}>
                        Join
                    </LoadingButton>
                </div>

                {loadingMyCodes ? (
                    <div className="joined-rooms" style={{marginTop: '16px'}}>
                        <div style={{display: 'flex', alignItems: 'center', gap: '8px'}}>
                            <span className="spinner" aria-hidden="true"/>
                        </div>
                    </div>
                ) : (myCodes && myCodes.length > 0) ? (
                    <div className="joined-rooms" style={{marginTop: '16px'}}>
                        <div style={{display: 'flex', alignItems: 'center', gap: '8px'}}>
                            <h3 style={{margin: 0}}>Previously joined</h3>
                        </div>
                        <div className="codes-list" style={{
                            marginTop: '8px',
                            display: 'flex',
                            gap: '8px',
                            flexWrap: 'wrap',
                            justifyContent: 'space-between'
                        }}>
                            {myCodes.map((code) => (
                                <button
                                    key={code}
                                    className="btn btn-secondary"
                                    onClick={() => {
                                        setJoinCode(String(code).toUpperCase());
                                        handleJoinRoom(String(code).toUpperCase());
                                    }}
                                    title={`Join room ${code}`}
                                >
                                    {String(code).toUpperCase()}
                                </button>
                            ))}
                        </div>
                    </div>
                ) : null}

                <button
                    onClick={() => setCurrentView('home')}
                    className="btn btn-link back-btn join-back-btn"
                    title="Back to Home"
                    aria-label="Back to Home"
                >
                    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                        <path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"></path>
                    </svg>
                </button>
            </div>
        </div>);
    }

    if (currentView === 'room') {
        return (<div className="app app--chat">
            <div className="chat-container">
                <div className="chat-header">
                    <div className="room-code-section">
                        <button
                            onClick={handleBackToJoin}
                            className="btn btn-link back-btn"
                            title="Back to Join"
                            aria-label="Back to Join"
                            style={{marginRight: '8px'}}
                        >
                            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                                <path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z"></path>
                            </svg>
                        </button>
                        <h2>Room: {roomCode}</h2>
                        <button
                            onClick={handleCopyRoomCode}
                            className={`btn btn-copy ${copySuccess ? 'copied' : ''}`}
                            title="Copy room link"
                        >
                            {copySuccess ? '✓ Copied!' : '📋 Copy Link'}
                        </button>
                    </div>
                    <div className="room-info">
                        <span>{room?.participants.length} participant(s)</span>
                        <span className={`timer-badge ${isExpired ? 'expired' : ''}`}
                              title="Time left in this session">
                {remainingMs == null ? '—:—' : ((() => {
                    const total = Math.max(remainingMs, 0);
                    const h = Math.floor(total / 3600000);
                    const m = Math.floor((total % 3600000) / 60000);
                    const s = Math.floor((total % 60000) / 1000);
                    if (h > 0) {
                        return `${String(h)}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
                    } else {
                        return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
                    }
                })())}
              </span>
                        {isCreator && (<button onClick={handleEndRoom} className="btn btn-small" disabled={isExpired}>
                            End Room
                        </button>)}
                        <button onClick={handleLeaveRoom} className="btn btn-small">
                            Leave Room
                        </button>
                    </div>
                </div>

                {error && <div className="error">{error}</div>}

                <div className="messages-container" ref={messagesContainerRef}>
                    {messages.length === 0 ? (<div className="no-messages">No messages yet. Start the
                        conversation!</div>) : (messages.map((message) => (<div key={message.id}
                                                                                className={`message ${principalToText(message.sender) === myPrincipal ? 'own' : 'other'}`}>
                        <div className="message-header">
                            <span className="sender">{formatMessageSender(message)}</span>
                            <span className="timestamp">{formatTime(message.timestamp)}</span>
                        </div>
                        <div className="message-content">{message.content}</div>
                    </div>)))}
                    <div ref={messagesEndRef}/>
                </div>

                <form onSubmit={handleSendMessage} className="message-form">
                    <input
                        type="text"
                        value={newMessage}
                        onChange={(e) => setNewMessage(e.target.value)}
                        placeholder="Type your message..."
                        className="message-input"
                        disabled={isExpired || isSending}
                    />
                    <LoadingButton type="submit" className="btn btn-primary send-btn" isLoading={isSending}
                                   disabled={isExpired} ariaLabel="Send message" title="Send message"
                                   showLabelWhenLoading={false}>
                        ➤
                    </LoadingButton>
                </form>
                {showExpiredModal && createPortal((<div className="modal-overlay" role="dialog" aria-modal="true">
                    <div className="modal">
                        <h3>Session Ended</h3>
                        <p>The room session has expired. Please return to the home page.</p>
                        <button className="btn btn-primary" onClick={handleLeaveRoom}>Go to Home</button>
                    </div>
                </div>), document.body)}
            </div>
        </div>);
    }

    return null;
}

export default App;