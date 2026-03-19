/*
 * © 2026 Heady Systems LLC.
 * PROPRIETARY AND CONFIDENTIAL.
 * Unauthorized copying, modification, or distribution is strictly prohibited.
 */
/**
 * ═══ Heady Admin — Command Center JS ═══
 * Firebase Auth + HeadyBuddy Chat + Voice + Live Dashboard
 */

// ── Config ──
const API_BASE = window.location.hostname === 'localhost'
    ? 'http://localhost:3301' : 'https://headyme.com';
const EDGE_API = 'https://heady-edge-gateway.emailheadyconnection.workers.dev';

// ── Firebase Config ──
// API key loaded at runtime from server-injected window.__FIREBASE_CONFIG__
// Set FIREBASE_API_KEY env var on the server; never hardcode here.
const firebaseConfig = (typeof window !== 'undefined' && window.__FIREBASE_CONFIG__) ? window.__FIREBASE_CONFIG__ : {
    apiKey: "",
    authDomain: "headyweb-d28e1.firebaseapp.com",
    projectId: "headyweb-d28e1",
    storageBucket: "headyweb-d28e1.firebasestorage.app",
    messagingSenderId: "1093838638453",
    appId: "1:1093838638453:web:d20d06186063fe26ce978f"
};

// ── State ──
let currentUser = null;
let buddyOpen = false;
let isRecording = false;
let recognition = null;
let refreshInterval = null;

// ═══ Init ═══
document.addEventListener('DOMContentLoaded', () => {
    initFirebase();
    initNavigation();
    initBuddy();
    initVoice();
    startLiveUpdates();
});

// ═══ Firebase Auth — Triple-Redundant Sign-In ═══
function initFirebase() {
    try {
        firebase.initializeApp(firebaseConfig);

        // Handle redirect result (from signInWithRedirect returning)
        firebase.auth().getRedirectResult().then(result => {
            if (result.user) {
                hideAuth();
                updateUserUI(result.user);
                syncUserData(result.user);
            }
        }).catch(err => {
            console.warn('Redirect result error:', err.message);
        });

        firebase.auth().onAuthStateChanged(user => {
            currentUser = user;
            if (user) {
                hideAuth();
                updateUserUI(user);
                syncUserData(user);
            } else {
                showAuth();
            }
        });

        // Google Sign-In — tries popup first, falls back to redirect
        document.getElementById('googleSignIn').addEventListener('click', () => {
            const provider = new firebase.auth.GoogleAuthProvider();

            // Method 1: Try popup (fast, works if domain is authorized)
            firebase.auth().signInWithPopup(provider).catch(err => {
                console.warn('Popup auth failed, trying redirect:', err.code);

                if (err.code === 'auth/unauthorized-domain' ||
                    err.code === 'auth/popup-blocked' ||
                    err.code === 'auth/popup-closed-by-user' ||
                    err.code === 'auth/operation-not-supported-in-this-environment') {
                    // Method 2: Redirect (works on any domain)
                    firebase.auth().signInWithRedirect(provider);
                } else {
                    showToast('Google Sign-In failed: ' + err.message, 'error');
                }
            });
        });

        // Email Sign-In / Sign-Up — Method 3: Always works, no domain restrictions
        let isSignUp = false;
        document.getElementById('toggleSignUp').addEventListener('click', (e) => {
            e.preventDefault();
            isSignUp = !isSignUp;
            e.target.textContent = isSignUp ? 'Sign in' : 'Sign up';
            e.target.parentElement.firstChild.textContent = isSignUp ? 'Have an account? ' : "Don't have an account? ";
            document.querySelector('.btn-email').textContent = isSignUp ? 'Create Account' : 'Sign In';
        });

        document.getElementById('emailForm').addEventListener('submit', (e) => {
            e.preventDefault();
            const email = document.getElementById('emailInput').value;
            const pass = document.getElementById('passInput').value;
            if (!email || !pass) { showToast('Enter email and password', 'error'); return; }
            const fn = isSignUp ? firebase.auth().createUserWithEmailAndPassword(email, pass)
                : firebase.auth().signInWithEmailAndPassword(email, pass);
            fn.catch(err => showToast('Auth failed: ' + err.message, 'error'));
        });

        // Auth button in header
        document.getElementById('authBtn').addEventListener('click', () => {
            if (currentUser) {
                if (confirm('Sign out?')) firebase.auth().signOut();
            } else {
                showAuth();
            }
        });
    } catch (err) {
        console.warn('Firebase init failed, proceeding without auth:', err);
        hideAuth();
    }
}

function showAuth() { document.getElementById('authModal').style.display = 'flex'; }
function hideAuth() { document.getElementById('authModal').style.display = 'none'; }

function updateUserUI(user) {
    const name = user.displayName || user.email?.split('@')[0] || 'Admin';
    document.getElementById('userName').textContent = name;
    const avatar = document.getElementById('userAvatar');
    if (user.photoURL) {
        avatar.innerHTML = `<img src="${user.photoURL}" style="width:100%;height:100%;border-radius:50%;object-fit:cover">`;
    } else {
        avatar.textContent = name.charAt(0).toUpperCase();
    }
}

async function syncUserData(user) {
    try {
        const db = firebase.firestore();
        const ref = db.collection('users').doc(user.uid);
        const doc = await ref.get();
        if (!doc.exists) {
            await ref.set({
                email: user.email, name: user.displayName || '',
                createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                role: 'admin', lastLogin: firebase.firestore.FieldValue.serverTimestamp(),
            });
        } else {
            await ref.update({ lastLogin: firebase.firestore.FieldValue.serverTimestamp() });
        }
    } catch (e) { console.warn('Firestore sync failed:', e); }
}

// ═══ Navigation ═══
function initNavigation() {
    document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', () => {
            const page = item.dataset.page;
            document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
            item.classList.add('active');
            document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
            document.getElementById(`page-${page}`).classList.add('active');
            document.getElementById('pageTitle').textContent = item.querySelector('span').textContent;
            // Load page data
            if (page === 'memory') loadMemoryPage();
            if (page === 'services') loadServicesPage();
            if (page === 'agents') loadAgentsPage();
            if (page === 'gateway') loadGatewayPage();
            if (page === 'settings') loadSettingsPage();
        });
    });
}

// ═══ HeadyBuddy Chat ═══
function initBuddy() {
    const panel = document.getElementById('buddyPanel');
    const toggle = document.getElementById('toggleBuddy');
    const close = document.getElementById('closeBuddy');
    const input = document.getElementById('buddyInput');
    const send = document.getElementById('buddySend');

    toggle.addEventListener('click', () => { buddyOpen = !buddyOpen; panel.classList.toggle('open', buddyOpen); });
    close.addEventListener('click', () => { buddyOpen = false; panel.classList.remove('open'); });

    const sendMsg = () => {
        const msg = input.value.trim();
        if (!msg) return;
        addBuddyMessage(msg, 'user');
        input.value = '';
        chatWithBuddy(msg);
    };

    send.addEventListener('click', sendMsg);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendMsg(); });
}

function addBuddyMessage(text, type) {
    const container = document.getElementById('buddyMessages');
    const div = document.createElement('div');
    div.className = `msg msg-${type}`;
    div.innerHTML = `<div class="msg-content">${escapeHtml(text)}</div>`;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
}

async function chatWithBuddy(message) {
    const typing = document.createElement('div');
    typing.className = 'msg msg-buddy';
    typing.innerHTML = '<div class="msg-content" style="opacity:0.5">Thinking...</div>';
    document.getElementById('buddyMessages').appendChild(typing);

    try {
        const res = await fetch(`${API_BASE}/api/brain/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message, system: 'You are HeadyBuddy, the friendly AI assistant in the Heady admin dashboard. Be concise, helpful, and proactive.' }),
        });
        const data = await res.json();
        typing.remove();
        if (data.ok) {
            addBuddyMessage(data.response, 'buddy');
        } else {
            addBuddyMessage('Sorry, I had trouble responding. Try again?', 'buddy');
        }
    } catch (err) {
        console.error('[HeadyBuddy] Chat request failed:', err);
        typing.remove();
        addBuddyMessage('Connection issue. Make sure HeadyManager is running.', 'buddy');
    }
}

// ═══ Voice Dictation ═══
function initVoice() {
    const btn = document.getElementById('voiceBtn');
    if (!('webkitSpeechRecognition' in window || 'SpeechRecognition' in window)) {
        btn.title = 'Voice not supported in this browser';
        btn.style.opacity = '0.3';
        return;
    }

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    let finalTranscript = '';

    recognition.onresult = (e) => {
        let interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
            if (e.results[i].isFinal) {
                finalTranscript += e.results[i][0].transcript + ' ';
            } else {
                interim += e.results[i][0].transcript;
            }
        }
        document.getElementById('buddyInput').value = finalTranscript + interim;
    };

    recognition.onend = () => {
        if (isRecording) recognition.start(); // Auto-restart
    };

    btn.addEventListener('click', () => {
        if (isRecording) {
            isRecording = false;
            recognition.stop();
            btn.classList.remove('recording');
            // Send what was dictated
            const text = document.getElementById('buddyInput').value.trim();
            if (text) {
                addBuddyMessage(text, 'user');
                document.getElementById('buddyInput').value = '';
                chatWithBuddy(text);
                finalTranscript = '';
            }
        } else {
            isRecording = true;
            finalTranscript = '';
            recognition.start();
            btn.classList.add('recording');
            // Open buddy panel if not already open
            if (!buddyOpen) {
                buddyOpen = true;
                document.getElementById('buddyPanel').classList.add('open');
            }
        }
    });
}

// ═══ Live Dashboard Updates ═══
function startLiveUpdates() {
    loadDashboard();
    refreshInterval = setInterval(loadDashboard, 15000); // Refresh every 15s
    document.getElementById('refreshHealth').addEventListener('click', loadDashboard);
}

async function loadDashboard() {
    // Fetch health + stats
    try {
        const [healthRes, statsRes] = await Promise.allSettled([
            fetch(`${API_BASE}/api/brain/health`).then(r => r.json()),
            fetch(`${API_BASE}/api/brain/stats`).then(r => r.json()),
        ]);

        const health = healthRes.status === 'fulfilled' ? healthRes.value : null;
        const stats = statsRes.status === 'fulfilled' ? statsRes.value : null;

        if (stats) {
            document.getElementById('statRequests').textContent = (stats.totalRequests || stats.stats?.totalRequests || 0).toLocaleString();
            document.getElementById('statCacheHits').textContent = (stats.cacheHits || stats.stats?.cacheHits || 0).toLocaleString();
            document.getElementById('statProviders').textContent = stats.providersLoaded || stats.providers || '6';
        }

        // PM2 services
        try {
            const pmRes = await fetch(`${API_BASE}/api/brain/pm2-status`).then(r => r.json());
            renderServices(pmRes);
        } catch (err) { console.error('[Dashboard] PM2 status fetch failed:', err); renderServicesPlaceholder(); }

        // Memory count
        try {
            const memRes = await fetch(`${API_BASE}/api/brain/memory-stats`).then(r => r.json());
            document.getElementById('statMemories').textContent = (memRes.total || memRes.count || 0).toLocaleString();
        } catch (err) {
            console.error('[Dashboard] Memory stats fetch failed:', err);
            document.getElementById('statMemories').textContent = '—';
        }

    } catch (err) { console.error('[Dashboard] Update failed:', err); }

    // Race audit
    try {
        const raceRes = await fetch(`${API_BASE}/api/brain/race-audit`).then(r => r.json());
        renderRaces(raceRes);
    } catch (err) { console.error('[Dashboard] Race audit fetch failed:', err); }
}

function renderServices(data) {
    const grid = document.getElementById('servicesGrid');
    const services = data.processes || data.services || data || [];
    if (!Array.isArray(services) || services.length === 0) {
        grid.innerHTML = '<div class="service-card"><div class="svc-header"><span class="svc-name">No service data</span></div></div>';
        return;
    }
    grid.innerHTML = services.slice(0, 12).map(s => `
        <div class="service-card">
            <div class="svc-header">
                <span class="svc-name">${escapeHtml(s.name || s.pm_id || '?')}</span>
                <span class="svc-status ${s.status === 'online' ? 'online' : 'offline'}">${s.status || '?'}</span>
            </div>
            <div class="svc-meta">${s.memory ? Math.round(s.memory / 1024 / 1024) + 'MB' : ''} · ↺${s.restarts || 0}</div>
        </div>
    `).join('');
}

function renderServicesPlaceholder() {
    const grid = document.getElementById('servicesGrid');
    grid.innerHTML = ['heady-manager', 'hcfp-auto-success', 'lens-feeder'].map(name => `
        <div class="service-card">
            <div class="svc-header">
                <span class="svc-name">${name}</span>
                <span class="svc-status online">online</span>
            </div>
        </div>
    `).join('');
}

function renderRaces(data) {
    const log = document.getElementById('raceLog');
    const races = data.races || data.entries || data || [];
    if (!Array.isArray(races) || races.length === 0) {
        log.innerHTML = '<div class="race-entry"><span style="color:var(--text-muted)">No race data yet</span></div>';
        return;
    }
    log.innerHTML = races.slice(0, 10).map(r => `
        <div class="race-entry">
            <span class="race-winner">🏆 ${escapeHtml(r.winner?.source || r.winner || '?')}</span>
            <span class="race-latency">${r.totalLatencyMs || r.latency || '?'}ms</span>
            <span class="race-providers">${(r.providersEntered || []).length || '?'} providers</span>
            <span class="race-time">${r.ts ? new Date(r.ts).toLocaleTimeString() : ''}</span>
        </div>
    `).join('');
}

// ═══ Memory Page ═══
function loadMemoryPage() {
    document.getElementById('memSearchBtn').onclick = async () => {
        const query = document.getElementById('memorySearch').value.trim();
        if (!query) return;
        try {
            const res = await fetch(`${API_BASE}/api/brain/memory/query`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query, topK: 10 }),
            });
            const data = await res.json();
            renderMemoryResults(data.results || data.memories || []);
        } catch (err) { console.error('[Memory] Query failed:', err); document.getElementById('memoryResults').innerHTML = '<p style="color:var(--text-muted)">Query failed</p>'; }
    };

    document.getElementById('memIngestBtn').onclick = async () => {
        const content = document.getElementById('memoryIngest').value.trim();
        if (!content) return;
        try {
            await fetch(`${API_BASE}/api/brain/memory/store`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content }),
            });
            showToast('Memory stored!', 'success');
            document.getElementById('memoryIngest').value = '';
        } catch (err) { console.error('[Memory] Store failed:', err); showToast('Failed to store', 'error'); }
    };
}

function renderMemoryResults(results) {
    const container = document.getElementById('memoryResults');
    if (results.length === 0) {
        container.innerHTML = '<p style="color:var(--text-muted)">No memories found</p>';
        return;
    }
    container.innerHTML = results.map(r => `
        <div class="memory-item">
            <div class="mem-score">Score: ${(r.score || r.similarity || 0).toFixed(4)}</div>
            <div class="mem-content">${escapeHtml((r.content || r.text || '').substring(0, 300))}</div>
        </div>
    `).join('');
}

// ═══ Other Pages ═══
function loadServicesPage() {
    const grid = document.getElementById('servicesFullGrid');
    grid.innerHTML = '<div class="service-card"><div class="svc-header"><span class="svc-name">Loading...</span></div></div>';
    fetch(`${API_BASE}/api/brain/pm2-status`).then(r => r.json()).then(data => {
        const services = data.processes || data || [];
        grid.innerHTML = services.map(s => `
            <div class="service-card">
                <div class="svc-header">
                    <span class="svc-name">${escapeHtml(s.name || '?')}</span>
                    <span class="svc-status ${s.status === 'online' ? 'online' : 'offline'}">${s.status || '?'}</span>
                </div>
                <div class="svc-meta">PID: ${s.pid || '?'} · Memory: ${s.memory ? Math.round(s.memory / 1024 / 1024) + 'MB' : '?'} · Restarts: ${s.restarts || 0}</div>
            </div>
        `).join('');
    }).catch(() => { grid.innerHTML = '<p style="color:var(--text-muted)">Could not load services</p>'; });
}

function loadAgentsPage() {
    const agents = [
        { icon: '🧠', name: 'HeadyBrain', desc: 'Core AI reasoning engine' },
        { icon: '⚔️', name: 'HeadyBattle', desc: 'Arena mode — multi-node competition' },
        { icon: '🔬', name: 'HeadyVinci', desc: 'Pattern recognition & prediction' },
        { icon: '💻', name: 'HeadyCoder', desc: 'Code generation & orchestration' },
        { icon: '🎨', name: 'HeadyCreative', desc: 'Image & media generation' },
        { icon: '🔍', name: 'HeadyLens', desc: 'Visual analysis & GPU vision' },
        { icon: '🧹', name: 'HeadyMaid', desc: 'System cleanup & scheduling' },
        { icon: '📡', name: 'HeadyOrchestrator', desc: 'Trinity communication relay' },
        { icon: '🛡️', name: 'HeadyRisks', desc: 'Security & vulnerability scanning' },
        { icon: '🌐', name: 'HeadyPerplexity', desc: 'Deep research & web search' },
        { icon: '🤖', name: 'HeadyClaude', desc: 'Advanced reasoning (Opus)' },
        { icon: '⚡', name: 'HeadyGemini', desc: 'Multimodal generation' },
        { icon: '🚀', name: 'HeadyGroq', desc: 'Ultra-fast inference' },
        { icon: '💬', name: 'HeadyBuddy', desc: 'Personal AI companion' },
        { icon: '🧬', name: 'HeadySoul', desc: 'Intelligence & learning layer' },
        { icon: '📋', name: 'HeadyJules', desc: 'Background task agent' },
        { icon: '🔗', name: 'HeadyOpenAI', desc: 'GPT integration & function calling' },
        { icon: '🤗', name: 'HeadyHuggingFace', desc: 'Open-weight model access' },
        { icon: '💻', name: 'HeadyCodex', desc: 'Code transformation' },
        { icon: '🎯', name: 'HeadyCopilot', desc: 'Inline code suggestions' },
    ];
    document.getElementById('agentsGrid').innerHTML = agents.map(a => `
        <div class="agent-card">
            <div class="agent-icon">${a.icon}</div>
            <div class="agent-name">${a.name}</div>
            <div class="agent-desc">${a.desc}</div>
        </div>
    `).join('');
}

function loadGatewayPage() {
    const info = document.getElementById('gatewayInfo');
    info.innerHTML = '<div class="gw-card"><div class="gw-label">Loading...</div></div>';

    Promise.allSettled([
        fetch(`${API_BASE}/api/brain/stats`).then(r => r.json()),
        fetch(`${EDGE_API}/health`).then(r => r.json()),
    ]).then(([localRes, edgeRes]) => {
        const local = localRes.status === 'fulfilled' ? localRes.value : null;
        const edge = edgeRes.status === 'fulfilled' ? edgeRes.value : null;

        info.innerHTML = `
            <div class="gw-card">
                <div class="gw-label">Local Gateway (HeadyManager)</div>
                <div class="gw-value">${local ? '✅ Online — ' + (local.providersLoaded || '?') + ' providers' : '❌ Offline'}</div>
            </div>
            <div class="gw-card">
                <div class="gw-label">Edge Gateway (CF Workers)</div>
                <div class="gw-value">${edge?.ok ? '✅ Online — edge.headyme.com' : '❌ Offline'}</div>
            </div>
            ${local?.stats ? `
            <div class="gw-card">
                <div class="gw-label">Race Statistics</div>
                <div class="gw-value">
                    Requests: ${local.stats.totalRequests || 0} · 
                    Cache Hits: ${local.stats.cacheHits || 0} · 
                    Semantic Hits: ${local.stats.semanticCacheHits || 0} · 
                    Failures: ${local.stats.failures || 0}
                </div>
            </div>
            <div class="gw-card">
                <div class="gw-label">Provider Wins</div>
                <div class="gw-value">${Object.entries(local.stats.wins || {}).map(([k, v]) => `${k}: ${v}`).join(' · ') || 'No races yet'}</div>
            </div>` : ''}
        `;
    });
}

function loadSettingsPage() {
    document.getElementById('settingsContent').innerHTML = `
        <div class="gw-card">
            <div class="gw-label">Account</div>
            <div class="gw-value">${currentUser?.email || 'Not signed in'}</div>
        </div>
        <div class="gw-card">
            <div class="gw-label">API Endpoint</div>
            <div class="gw-value">${API_BASE}</div>
        </div>
        <div class="gw-card">
            <div class="gw-label">Edge Endpoint</div>
            <div class="gw-value">${EDGE_API}</div>
        </div>
        <div class="gw-card" style="margin-top:16px">
            <div class="gw-label">Semantic Cache Threshold</div>
            <div style="display:flex;align-items:center;gap:12px;margin-top:8px">
                <input type="range" min="0.5" max="0.99" step="0.01" value="0.85" style="flex:1" id="thresholdSlider">
                <span id="thresholdVal" style="font-weight:700;font-variant-numeric:tabular-nums">0.85</span>
            </div>
        </div>
    `;
    document.getElementById('thresholdSlider')?.addEventListener('input', (e) => {
        document.getElementById('thresholdVal').textContent = e.target.value;
    });
}

// ═══ Utils ═══
function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
}

function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.style.cssText = `
        position:fixed;bottom:24px;right:24px;z-index:9999;
        padding:12px 20px;border-radius:10px;font-size:13px;font-weight:600;
        color:#fff;box-shadow:0 4px 20px rgba(0,0,0,0.4);
        animation:slideIn 0.3s ease;font-family:Inter,sans-serif;
        background:${type === 'error' ? '#ef4444' : type === 'success' ? '#22c55e' : '#3b82f6'};
    `;
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; toast.style.transition = '0.3s'; setTimeout(() => toast.remove(), 300); }, 3000);
}
