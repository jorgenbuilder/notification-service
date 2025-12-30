import {useEffect, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {canisterId as chatCanisterId, createActor as createChatActor} from 'declarations/chat_backend';
import {
    canisterId as notificationsCanisterId,
    createActor as createNotificationsActor
} from 'declarations/notification_canister';
import {HttpAgent} from '@dfinity/agent';
import {Ed25519KeyIdentity} from '@dfinity/identity';
import './index.scss';
import LoadingButton from './components/LoadingButton';
import {Principal} from "@dfinity/principal";

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


function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
        outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
}

function arrayBufferToBase64Url(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    const base64 = btoa(binary);
    return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function App() {
    const [vapidPublicKey, setVapidPublicKey] = useState('');
    const [chatActor, setChatActor] = useState(null);
    const chatActorRef = useRef(null);
    const [notificationsActor, setNotificationsActor] = useState(null);
    const notificationsActorRef = useRef(null);
    const pendingJoinRef = useRef('');
    const [currentView, setCurrentView] = useState('home'); // 'home', 'room', 'join'
    const [roomCode, setRoomCode] = useState('');
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

    // PWA / Push state
    const [swReady, setSwReady] = useState(false);
    const [swReg, setSwReg] = useState(null);
    const [permissionStatus, setPermissionStatus] = useState(typeof Notification !== 'undefined' ? Notification.permission : 'default');
    const [pushStatus, setPushStatus] = useState('idle'); // 'idle' | 'subscribed' | 'error'
    const [pushError, setPushError] = useState('');
    const [myPrincipal, setMyPrincipal] = useState('');
    // Identity/storage diagnostics
    const [idStorageSource, setIdStorageSource] = useState('');
    const [idStorageError, setIdStorageError] = useState('');
    const [persistGranted, setPersistGranted] = useState(null); // null | boolean
    const [persistSupported, setPersistSupported] = useState(false);

    const SESSION_TIMEOUT_MS = 20 * 60 * 1000; // Keep in sync with backend

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({behavior: "smooth"});
    };

    useEffect(() => {
        scrollToBottom();
    }, [messages]);

    useEffect(() => {
        (async () => {
            try {
                const identity = await getOrCreateIdentity((diag) => {
                    if (!diag) return;
                    if (diag.source) setIdStorageSource(diag.source);
                    if (diag.error) setIdStorageError(diag.error);
                });
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
                const ca = createChatActor(chatCanisterId, {agent});
                chatActorRef.current = ca;
                setChatActor(ca);
                const na = createNotificationsActor(notificationsCanisterId, {agent});
                notificationsActorRef.current = na;
                setNotificationsActor(na);
                try {
                    const key = await na.getVapidPublicKey();
                    if (typeof key === 'string' && key.length > 0) {
                        setVapidPublicKey(key);
                    } else {
                        console.warn('getVapidPublicKey returned empty value');
                    }
                } catch (e) {
                    console.warn('Failed to fetch VAPID public key', e);
                }
            } catch (e) {
                console.error('Failed to init identity/actor', e);
                setIdStorageError((prev) => prev ? prev + ' | ' + (e?.message || String(e)) : (e?.message || String(e)));
            }
        })();
    }, []);

    // Register Service Worker on first load (no permission request on iOS without user gesture)
    useEffect(() => {
        (async () => {
            if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
                console.warn('Push notifications not supported in this browser.');
                setPushError('Push notifications not supported on this device/browser');
                return;
            }
            try {
                const reg = await navigator.serviceWorker.register('/sw.js');
                setSwReg(reg);
                await navigator.serviceWorker.ready;
                setSwReady(true);
                setPermissionStatus(typeof Notification !== 'undefined' ? Notification.permission : 'default');

                // If already subscribed (e.g., after reinstall), send to backend
                try {
                    const sub = await reg.pushManager.getSubscription();
                    if (sub) {
                        const p256dh = arrayBufferToBase64Url(sub.getKey('p256dh'));
                        const auth = arrayBufferToBase64Url(sub.getKey('auth'));
                        const endpoint = sub.endpoint;
                        const expirationTime = sub.expirationTime; // may be null
                        const payload = {
                            endpoint,
                            expirationTime: expirationTime === null ? [] : [Number(expirationTime)],
                            keys: {p256dh, auth},
                        };
                        if (notificationsActorRef.current) {
                            await notificationsActorRef.current.subscribe(Principal.fromText(chatCanisterId), payload);
                            setPushStatus('subscribed');
                        }
                    }
                } catch (e) {
                    console.warn('Existing push subscription check failed', e);
                }
            } catch (e) {
                console.warn('Service worker registration failed', e);
                setPushError('Service worker registration failed: ' + (e?.message || e));
            }
        })();
    }, []);

    // Request persistent storage (helps Safari/iOS and desktop not evict data)
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                if (!('storage' in navigator) || !navigator.storage || !navigator.storage.persist) {
                    if (!cancelled) setPersistSupported(false);
                    return;
                }
                setPersistSupported(true);
                // First check if already persisted
                if (navigator.storage.persisted) {
                    try {
                        const already = await navigator.storage.persisted();
                        if (!cancelled) setPersistGranted(!!already);
                    } catch (_) {
                    }
                }
                // Request persistence if not already granted
                if (navigator.storage.persist) {
                    try {
                        const granted = await navigator.storage.persist();
                        if (!cancelled) setPersistGranted(!!granted);
                    } catch (_) {
                    }
                }
            } catch (e) {
                if (!cancelled) setIdStorageError((prev) => prev ? prev + ' | persist() error: ' + (e?.message || String(e)) : 'persist() error: ' + (e?.message || String(e)));
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    // Listen for messages from Service Worker (e.g., OPEN_URL from notificationclick)
    useEffect(() => {
        function onSwMessage(event) {
            try {
                const data = event?.data || {};
                if (data?.type === 'OPEN_URL' && data?.url) {
                    const url = data.url;
                    // Only handle same-origin http(s) URLs
                    const target = new URL(url, window.location.origin);
                    if (target.origin !== window.location.origin) return;
                    // If we are already at target, just focus
                    if (window.location.href === target.href) return;
                    // Navigate the page so initial URL parsing logic runs (joins by refID)
                    window.location.href = target.href;
                }
            } catch (_) {
                // ignore
            }
        }

        if (navigator?.serviceWorker) {
            navigator.serviceWorker.addEventListener('message', onSwMessage);
        }
        return () => {
            if (navigator?.serviceWorker) {
                navigator.serviceWorker.removeEventListener('message', onSwMessage);
            }
        };
    }, []);

    // User-gesture flow to enable push on iOS
    async function enablePush() {
        try {
            setPushError('');
            if (!swReg) {
                // Ensure SW is ready
                const reg = await navigator.serviceWorker.register('/sw.js');
                setSwReg(reg);
                await navigator.serviceWorker.ready;
                setSwReady(true);
            }
            const perm = await Notification.requestPermission();
            setPermissionStatus(perm);
            if (perm !== 'granted') {
                setPushStatus('error');
                setPushError('Notification permission not granted');
                return;
            }

            let currentKey = vapidPublicKey;
            if (!currentKey || currentKey.length === 0) {
                try {
                    if (notificationsActorRef.current) {
                        const fetched = await notificationsActorRef.current.getVapidPublicKey();
                        if (typeof fetched === 'string' && fetched.length > 0) {
                            currentKey = fetched;
                            setVapidPublicKey(fetched);
                        }
                    }
                } catch (_) { /* ignore; will error below if still missing */ }
            }
            if (!currentKey || currentKey.length === 0) {
                setPushStatus('error');
                setPushError('VAPID public key not available yet. Please try again in a moment.');
                return;
            }

            const LAST_VAPID_KEY_STORAGE = 'chat.lastVapidPublicKey';
            const doSubscribe = async () => {
                return await swReg.pushManager.subscribe({
                    userVisibleOnly: true,
                    applicationServerKey: urlBase64ToUint8Array(currentKey),
                });
            };

            let sub = null;
            try {
                sub = await doSubscribe();
            } catch (e1) {
                const msg = e1?.message || '';
                if (e1?.name === 'InvalidStateError' || msg.includes('different applicationServerKey')) {
                    try {
                        const existing = await swReg.pushManager.getSubscription();
                        if (existing) {
                            try { await existing.unsubscribe(); } catch (_) {}
                        }
                    } catch (_) {}
                    sub = await doSubscribe();
                } else {
                    const existing = await swReg.pushManager.getSubscription();
                    if (existing) {
                        sub = existing;
                    } else {
                        throw e1;
                    }
                }
            }

            try { localStorage.setItem(LAST_VAPID_KEY_STORAGE, currentKey); } catch (_) {}

            const p256dh = arrayBufferToBase64Url(sub.getKey('p256dh'));
            const auth = arrayBufferToBase64Url(sub.getKey('auth'));
            const endpoint = sub.endpoint;
            const expirationTime = sub.expirationTime;
            const payload = {
                endpoint,
                expirationTime: expirationTime === null ? [] : [Number(expirationTime)],
                keys: {p256dh, auth},
            };
            if (notificationsActorRef.current) {
                await notificationsActorRef.current.subscribe(Principal.fromText(chatCanisterId), payload);
                try { localStorage.setItem('chat.lastPushEndpoint', endpoint); } catch (_) {}
                setPushStatus('subscribed');
            } else {
                setPushStatus('error');
                setPushError('Backend actor not ready; try again in a moment');
            }
        } catch (e) {
            console.warn('Enable push failed', e);
            setPushStatus('error');
            setPushError(e?.message || String(e));
        }
    }

    async function disablePush() {
        try {
            setPushError('');
            let sub = null;
            if (swReg) {
                try {
                    sub = await swReg.pushManager.getSubscription();
                } catch (_) {
                    // pass
                }
            }
            let endpoint = null;
            if (sub && sub.endpoint) endpoint = sub.endpoint;
            if (!endpoint) {
                try { endpoint = localStorage.getItem('chat.lastPushEndpoint') || null; } catch (_) {}
            }

            if (endpoint && notificationsActorRef.current) {
                try {
                    await notificationsActorRef.current.unsubscribe(Principal.fromText(chatCanisterId), endpoint);
                } catch (e) {
                    setPushError('Backend unsubscribe failed: ' + (e?.message || String(e)));
                }
            }

            if (sub) {
                try { await sub.unsubscribe(); } catch (_) {}
            }

            try { localStorage.removeItem('chat.lastPushEndpoint'); } catch (_) {}

            setPushStatus('idle');
        } catch (e) {
            setPushError(e?.message || String(e));
        }
    }

    async function testLocalNotification() {
        try {
            if (!swReady || !swReg) {
                setPushError('Service worker not ready');
                return;
            }
            if (permissionStatus !== 'granted') {
                setPushError('Permission not granted');
                return;
            }
            await swReg.showNotification('Local test', {body: 'If you see this, notifications are allowed.'});
        } catch (e) {
            setPushError('Local notification failed: ' + (e?.message || String(e)));
        }
    }

    // Check for room code in URL on component mount and auto-join deterministically
    useEffect(() => {
        const urlParams = new URLSearchParams(window.location.search);
        const refId = urlParams.get('refID');
        if (refId && refId.length === 6) {
            const code = refId.toUpperCase();
            setJoinCode(code);
            setCurrentView('join');
            if (chatActorRef.current) {
                handleJoinRoom(code, {silent: true});
            } else {
                // Defer until actor is ready
                pendingJoinRef.current = code;
            }
        }
    }, []);

    // When backend actor becomes ready, perform any pending auto-join
    useEffect(() => {
        if (chatActorRef.current && pendingJoinRef.current) {
            const code = pendingJoinRef.current;
            pendingJoinRef.current = '';
            handleJoinRoom(code, {silent: true});
        }
    }, [chatActor]);

    // Update URL when room code changes
    useEffect(() => {
        if (roomCode && currentView === 'room') {
            const newUrl = `${window.location.origin}${window.location.pathname}?refID=${roomCode}`;
            window.history.pushState({}, '', newUrl);
        }
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

    // Poll for new messages every 2 seconds
    useEffect(() => {
        if (currentView === 'room' && roomCode) {
            const interval = setInterval(async () => {
                try {
                    if (!chatActorRef.current) return;
                    const roomMessages = await chatActorRef.current.getMessages(roomCode);
                    setMessages(roomMessages);
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
            const result = await chatActorRef.current.joinRoom(codeRaw);

            if ('Ok' in result) {
                setRoomCode(codeRaw);
                setRoom(result.Ok.room);
                setMessages(result.Ok.room.messages);
                const creatorText = principalToText(result.Ok.room.creator);
                setIsCreator(creatorText === myPrincipal);
                setCurrentView('room');
                setShowExpiredModal(false);
                setIsExpired(false);
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
        e.preventDefault();
        if (isSending) return;
        if (!newMessage.trim() || isExpired) return;
        setIsSending(true);

        try {
            if (!chatActorRef.current) throw new Error('Actor not ready');
            const result = await chatActorRef.current.sendMessage(roomCode, newMessage.trim());

            if ('Ok' in result) {
                setMessages(prev => [...prev, result.Ok]);
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

    const handleLeaveRoom = async () => {
        try {
            if (!chatActorRef.current) throw new Error('Actor not ready');
            await chatActorRef.current.leaveRoom(roomCode);
        } catch (err) {
            console.error('Error leaving room:', err);
        } finally {
            setCurrentView('home');
            setRoomCode('');
            setRoom(null);
            setMessages([]);
            setNewMessage('');
            setError('');
            // Clear URL parameters
            window.history.pushState({}, '', window.location.pathname);
        }
    };

    const handleCopyRoomCode = async () => {
        try {
            const roomUrl = `${window.location.origin}${window.location.pathname}?refID=${roomCode}`;
            await navigator.clipboard.writeText(roomUrl);
            setCopySuccess(true);
            setTimeout(() => setCopySuccess(false), 2000);
        } catch (err) {
            // Fallback for older browsers
            const textArea = document.createElement('textarea');
            textArea.value = `${window.location.origin}${window.location.pathname}?refID=${roomCode}`;
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
        return (
            <div className="app">
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
                        <h3>Notifications</h3>
                        <div style={{fontSize: '0.95em', lineHeight: 1.6}}>
                            <div>Service Worker: {swReady ? 'ready' : 'not ready'}</div>
                            <div>Permission: {permissionStatus}</div>
                            <div>Push: {pushStatus}</div>
                            <div>My principal: {myPrincipal || 'unknown'}</div>
                            <div>Identity storage: {idStorageSource || 'unknown'}</div>
                            <div>
                                Storage
                                persistence: {persistSupported ? (persistGranted === null ? 'checking…' : (persistGranted ? 'granted' : 'not granted')) : 'unsupported'}
                            </div>
                            {idStorageError && <div className="error" style={{marginTop: '8px'}}>Identity storage
                                error: {idStorageError}</div>}
                            {pushError && <div className="error" style={{marginTop: '8px'}}>{pushError}</div>}
                        </div>
                        <div className="button-group" style={{marginTop: '12px'}}>
                            <button
                                onClick={enablePush}
                                className="btn btn-secondary"
                                disabled={permissionStatus === 'granted' && pushStatus === 'subscribed'}
                                title="Enable notifications (required on iOS via a user tap)"
                            >
                                {permissionStatus === 'granted' && pushStatus === 'subscribed' ? 'Notifications enabled' : 'Enable notifications'}
                            </button>
                            <button
                                onClick={disablePush}
                                className="btn btn-warning"
                                disabled={pushStatus !== 'subscribed'}
                                title="Disable notifications and unregister on server"
                            >
                                Disable notifications
                            </button>
                            <button
                                onClick={testLocalNotification}
                                className="btn"
                                disabled={!swReady || permissionStatus !== 'granted'}
                                title="Show a local test notification"
                            >
                                Test local notification
                            </button>
                        </div>
                        <div style={{marginTop: '8px', fontSize: '0.9em', opacity: 0.8}}>
                            Tip: On iOS, install from Safari via Share → Add to Home Screen, then open the app icon and
                            tap “Enable notifications”.
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    if (currentView === 'join') {
        return (
            <div className="app">
                <div className="container">
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

                    <button onClick={() => setCurrentView('home')} className="btn btn-link">
                        ← Back to Home
                    </button>
                </div>
            </div>
        );
    }

    if (currentView === 'room') {
        return (
            <div className="app">
                <div className="chat-container">
                    <div className="chat-header">
                        <div className="room-code-section">
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
                {remainingMs == null ? '—:—' : (
                    (() => {
                        const total = Math.max(remainingMs, 0);
                        const m = Math.floor(total / 60000);
                        const s = Math.floor((total % 60000) / 1000);
                        return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
                    })()
                )}
              </span>
                            {isCreator && (
                                <button onClick={handleEndRoom} className="btn btn-small" disabled={isExpired}>
                                    End Room
                                </button>
                            )}
                            <button onClick={handleLeaveRoom} className="btn btn-small">
                                Leave Room
                            </button>
                        </div>
                    </div>

                    {error && <div className="error">{error}</div>}

                    <div className="messages-container">
                        {messages.length === 0 ? (
                            <div className="no-messages">No messages yet. Start the conversation!</div>
                        ) : (
                            messages.map((message) => (
                                <div key={message.id}
                                     className={`message ${principalToText(message.sender) === myPrincipal ? 'own' : 'other'}`}>
                                    <div className="message-header">
                                        <span className="sender">{formatMessageSender(message)}</span>
                                        <span className="timestamp">{formatTime(message.timestamp)}</span>
                                    </div>
                                    <div className="message-content">{message.content}</div>
                                </div>
                            ))
                        )}
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
                        <LoadingButton type="submit" className="btn btn-primary" isLoading={isSending}
                                       disabled={isExpired}>
                            Send
                        </LoadingButton>
                    </form>
                    {showExpiredModal && createPortal(
                        (
                            <div className="modal-overlay" role="dialog" aria-modal="true">
                                <div className="modal">
                                    <h3>Session Ended</h3>
                                    <p>The room session has expired. Please return to the home page.</p>
                                    <button className="btn btn-primary" onClick={handleLeaveRoom}>Go to Home</button>
                                </div>
                            </div>
                        ),
                        document.body
                    )}
                </div>
            </div>
        );
    }

    return null;
}

export default App;