require('dotenv').config();
const express = require('express');
const makeWASocket = require('baileysjs').default;
const { DisconnectReason, useMultiFileAuthState } = require('baileysjs');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 4000;

// Middleware d'authentification par clé API
const authenticateApiKey = (req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    
    if (!apiKey || apiKey !== process.env.API_KEY) {
        return res.status(401).json({
            success: false,
            error: 'Clé API invalide ou manquante'
        });
    }
    
    next();
};

app.use(express.json());
// Routes protégées (avec authentification)
app.use(authenticateApiKey);

let sock = null;
let qrString = null;

// Fichier pour stocker l'état de connexion
const CONNECTION_STATE_FILE = './connection_state.json';
const AUTH_FOLDER = './auth_info_baileys';

// Classe pour gérer l'état de connexion
class ConnectionStateManager {
    constructor() {
        this.state = {
            isConnected: false,
            lastConnected: null,
            phoneNumber: null,
            sessionId: null,
            deviceId: null
        };
        this.loadState();
    }

    loadState() {
        try {
            if (fs.existsSync(CONNECTION_STATE_FILE)) {
                const data = fs.readFileSync(CONNECTION_STATE_FILE, 'utf8');
                this.state = { ...this.state, ...JSON.parse(data) };
                console.log('📂 État de connexion chargé:', this.state);
            }
        } catch (error) {
            console.error('❌ Erreur lors du chargement de l\'état:', error);
        }
    }

    saveState() {
        try {
            fs.writeFileSync(CONNECTION_STATE_FILE, JSON.stringify(this.state, null, 2));
            console.log('💾 État de connexion sauvegardé');
        } catch (error) {
            console.error('❌ Erreur lors de la sauvegarde de l\'état:', error);
        }
    }

    setConnected(phoneNumber = null, deviceId = null) {
        this.state.isConnected = true;
        this.state.lastConnected = new Date().toISOString();
        this.state.phoneNumber = phoneNumber;
        this.state.deviceId = deviceId;
        this.state.sessionId = this.generateSessionId();
        this.saveState();
    }

    setDisconnected() {
        this.state.isConnected = false;
        this.state.sessionId = null;
        this.saveState();
    }

    isAuthValid() {
        // Vérifier si le dossier d'authentification existe et contient les fichiers nécessaires
        if (!fs.existsSync(AUTH_FOLDER)) {
            return false;
        }

        const requiredFiles = ['creds.json'];
        return requiredFiles.every(file => 
            fs.existsSync(path.join(AUTH_FOLDER, file))
        );
    }

    getConnectionInfo() {
        return {
            ...this.state,
            hasValidAuth: this.isAuthValid(),
            authFolderExists: fs.existsSync(AUTH_FOLDER)
        };
    }

    generateSessionId() {
        return `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    clear() {
        this.state = {
            isConnected: false,
            lastConnected: null,
            phoneNumber: null,
            sessionId: null,
            deviceId: null
        };
        this.saveState();
    }
}

const connectionManager = new ConnectionStateManager();

// Fonction pour générer un code OTP aléatoire
function generateOTP(length = 6) {
    const digits = '0123456789';
    let otp = '';
    for (let i = 0; i < length; i++) {
        otp += digits[Math.floor(Math.random() * digits.length)];
    }
    return otp;
}

// Fonction pour formater le numéro de téléphone
function formatPhoneNumber(phoneNumber) {
    let cleaned = phoneNumber.replace(/[^\d+]/g, '');
    
    if (cleaned.startsWith('+')) {
        cleaned = cleaned.substring(1);
    }
    
    return `${cleaned}@s.whatsapp.net`;
}

// Fonction pour vérifier l'état de la connexion actuelle
async function checkCurrentConnection() {
    if (!sock) return false;
    
    try {
        // Essayer d'obtenir des informations sur l'utilisateur connecté
        const user = sock.user;
        if (user && user.id) {
            connectionManager.setConnected(user.id, user.id);
            return true;
        }
    } catch (error) {
        console.log('⚠️ Connexion non valide:', error.message);
    }
    
    return false;
}

// Fonction pour initialiser la connexion WhatsApp
async function connectToWhatsApp() {
    try {
        console.log('🔄 Initialisation de la connexion WhatsApp...');
        
        // Vérifier si on a déjà des credentials valides
        const hasValidAuth = connectionManager.isAuthValid();
        console.log(`🔐 Authentification existante: ${hasValidAuth ? 'OUI' : 'NON'}`);
        
        // Utiliser l'authentification multi-fichiers
        const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
        
        sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            logger: require('pino')({ level: 'silent' }),
            browser: ['WhatsApp OTP Server', 'Chrome', '1.0.0'],
            syncFullHistory: false,
            markOnlineOnConnect: true
        });

        // Gérer les mises à jour de connexion
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                qrString = qr;
                console.log('📱 QR Code généré - disponible via /qr');
            }
            
            if (connection === 'close') {
                const statusCode = (lastDisconnect?.error)?.output?.statusCode;
                console.log('🔴 Connexion fermée à cause de:', lastDisconnect?.error);

                // If 401 Unauthorized, clear auth and force new QR
                if (statusCode === 401) {
                    console.log('🧹 Authentification invalide, suppression des fichiers d\'auth...');
                    if (fs.existsSync(AUTH_FOLDER)) {
                        fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
                    }
                    connectionManager.clear();
                    qrString = null;
                    // Wait a bit before reconnecting to allow QR regeneration
                    setTimeout(connectToWhatsApp, 2000);
                } else {
                    connectionManager.setDisconnected();
                    qrString = null;
                    const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                    if (shouldReconnect) {
                        console.log('🔄 Reconnexion dans 3 secondes...');
                        setTimeout(connectToWhatsApp, 3000);
                    } else {
                        console.log('🚫 Déconnexion définitive - QR requis');
                    }
                }
            } else if (connection === 'open') {
                console.log('✅ Connexion WhatsApp établie');
                qrString = null;
                
                // Obtenir les informations de l'utilisateur connecté
                if (sock.user) {
                    connectionManager.setConnected(sock.user.id, sock.user.id);
                    console.log(`👤 Connecté en tant que: ${sock.user.id}`);
                } else {
                    connectionManager.setConnected();
                }
            } else if (connection === 'connecting') {
                console.log('🔄 Connexion en cours...');
            }
        });

        // Sauvegarder les credentials quand ils sont mis à jour
        sock.ev.on('creds.update', saveCreds);

        // Gérer les messages reçus (optionnel - pour debug)
        sock.ev.on('messages.upsert', async (m) => {
            const message = m.messages[0];
            if (!message.key.fromMe && message.message) {
                console.log('📨 Message reçu de:', message.key.remoteJid);
            }
        });

        sock.ev.on('error', (err) => {
            console.error('Socket error:', err);
        });

    } catch (error) {
        console.error('❌ Erreur lors de la connexion:', error);
        connectionManager.setDisconnected();
        setTimeout(connectToWhatsApp, 5000);
    }
}

// Helper to wrap async route handlers
const asyncHandler = fn => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
};

// Routes publiques (sans authentification)
app.get('/qr-view', async (req, res) => {
    if (!qrString) {
        const connectionInfo = connectionManager.getConnectionInfo();
        return res.send(`
            <h2>QR code non disponible</h2>
            <p>État de connexion: ${connectionInfo.isConnected ? 'Connecté' : 'Déconnecté'}</p>
            <p>Authentification valide: ${connectionInfo.hasValidAuth ? 'Oui' : 'Non'}</p>
            <button onclick="location.reload()">Rafraîchir</button>
        `);
    }
    
    const qrImageUrl = await QRCode.toDataURL(qrString);
    res.send(`
        <h2>Scannez ce QR code avec WhatsApp</h2>
        <img src="${qrImageUrl}" alt="QR Code" />
        <p>Ouvrez WhatsApp &gt; Appareils connectés &gt; Scanner un QR code</p>
        <button onclick="location.reload()">Rafraîchir</button>
    `);
});

app.get('/status', async (req, res) => {
    const connectionInfo = connectionManager.getConnectionInfo();
    let realTimeStatus = false;
    if (sock) {
        realTimeStatus = await checkCurrentConnection();
    }
    res.json({
        connected: connectionInfo.isConnected && realTimeStatus,
        hasQR: !!qrString,
        lastConnected: connectionInfo.lastConnected,
        phoneNumber: connectionInfo.phoneNumber,
        sessionId: connectionInfo.sessionId,
        hasValidAuth: connectionInfo.hasValidAuth,
        authFolderExists: connectionInfo.authFolderExists,
        socketActive: !!sock,
        realTimeConnected: realTimeStatus,
        timestamp: new Date().toISOString()
    });
});


// Route pour obtenir des informations détaillées sur l'authentification
app.get('/auth-info', async (req, res) => {
    const connectionInfo = connectionManager.getConnectionInfo();
    
    // Vérifier l'état réel de la connexion si le socket existe
    let realTimeStatus = false;
    if (sock) {
        realTimeStatus = await checkCurrentConnection();
    }
    
    res.json({
        connected: connectionInfo.isConnected && realTimeStatus,
        hasQR: !!qrString,
        lastConnected: connectionInfo.lastConnected,
        phoneNumber: connectionInfo.phoneNumber,
        sessionId: connectionInfo.sessionId,
        hasValidAuth: connectionInfo.hasValidAuth,
        authFolderExists: connectionInfo.authFolderExists,
        socketActive: !!sock,
        realTimeConnected: realTimeStatus,
        timestamp: new Date().toISOString()
    });
});

// Route pour obtenir des informations détaillées sur l'authentification
app.get('/auth-info', (req, res) => {
    const connectionInfo = connectionManager.getConnectionInfo();
    let authFiles = [];
    
    if (fs.existsSync(AUTH_FOLDER)) {
        try {
            authFiles = fs.readdirSync(AUTH_FOLDER);
        } catch (error) {
            console.error('Erreur lecture dossier auth:', error);
        }
    }
    
    res.json({
        hasValidAuth: connectionInfo.hasValidAuth,
        authFolderExists: connectionInfo.authFolderExists,
        authFiles: authFiles,
        lastConnected: connectionInfo.lastConnected,
        phoneNumber: connectionInfo.phoneNumber,
        canAutoConnect: connectionInfo.hasValidAuth && authFiles.includes('creds.json')
    });
});

// Route pour obtenir le QR code si disponible
app.get('/qr', (req, res) => {
    if (qrString) {
        res.json({
            qr: qrString,
            message: 'Scannez ce QR code avec WhatsApp'
        });
    } else if (connectionManager.getConnectionInfo().isConnected) {
        res.json({
            message: 'WhatsApp est déjà connecté',
            connected: true
        });
    } else {
        res.status(404).json({
            error: 'QR code non disponible',
            hasValidAuth: connectionManager.isAuthValid()
        });
    }
});

// Route pour envoyer un code OTP
app.post('/send-otp', async (req, res) => {
    try {
        const { phoneNumber, message, otpLength } = req.body;

        // Validation des paramètres
        if (!phoneNumber) {
            return res.status(400).json({
                success: false,
                error: 'Le numéro de téléphone est requis'
            });
        }

        // Vérifier l'état de la connexion
        const isReallyConnected = await checkCurrentConnection();
        if (!isReallyConnected || !sock) {
            return res.status(503).json({
                success: false,
                error: 'WhatsApp n\'est pas connecté. Veuillez scanner le QR code.',
                hasValidAuth: connectionManager.isAuthValid(),
                needsQR: !connectionManager.isAuthValid()
            });
        }

        // Générer le code OTP
        const otp = generateOTP(otpLength || 6);
        
        // Formater le numéro
        const formattedNumber = formatPhoneNumber(phoneNumber);
        
        // Vérifier si le numéro existe sur WhatsApp
        const [result] = await sock.onWhatsApp(formattedNumber.replace('@s.whatsapp.net', ''));
        if (!result.exists) {
            return res.status(404).json({
                success: false,
                error: 'Ce numéro n\'existe pas sur WhatsApp'
            });
        }

        // Préparer le message
        const otpMessage = message 
            ? message.replace('{otp}', otp) 
            : `Votre code OTP est: *${otp}*\n\nCe code expire dans 10 minutes.`;

        // Envoyer le message
        const sentMessage = await sock.sendMessage(formattedNumber, {
            text: otpMessage
        });

        console.log(`📤 OTP ${otp} envoyé à ${phoneNumber}`);

        res.json({
            success: true,
            message: 'Code OTP envoyé avec succès',
            data: {
                otp: otp, // En production, vous pourriez vouloir ne pas renvoyer l'OTP
                phoneNumber: phoneNumber,
                messageId: sentMessage.key.id,
                sessionId: connectionManager.getConnectionInfo().sessionId,
                timestamp: new Date().toISOString()
            }
        });

    } catch (error) {
        console.error('❌ Erreur lors de l\'envoi de l\'OTP:', error);
        res.status(500).json({
            success: false,
            error: 'Erreur interne du serveur',
            details: error.message
        });
    }
});

// Route pour envoyer un message personnalisé
app.post('/send-message', async (req, res) => {
    try {
        const { phoneNumber, message } = req.body;

        if (!phoneNumber || !message) {
            return res.status(400).json({
                success: false,
                error: 'Le numéro de téléphone et le message sont requis'
            });
        }

        const isReallyConnected = await checkCurrentConnection();
        if (!isReallyConnected || !sock) {
            return res.status(503).json({
                success: false,
                error: 'WhatsApp n\'est pas connecté'
            });
        }

        const formattedNumber = formatPhoneNumber(phoneNumber);
        
        // Vérifier si le numéro existe
        const [result] = await sock.onWhatsApp(formattedNumber.replace('@s.whatsapp.net', ''));
        if (!result.exists) {
            return res.status(404).json({
                success: false,
                error: 'Ce numéro n\'existe pas sur WhatsApp'
            });
        }

        const sentMessage = await sock.sendMessage(formattedNumber, {
            text: message
        });

        res.json({
            success: true,
            message: 'Message envoyé avec succès',
            data: {
                phoneNumber: phoneNumber,
                messageId: sentMessage.key.id,
                sessionId: connectionManager.getConnectionInfo().sessionId,
                timestamp: new Date().toISOString()
            }
        });

    } catch (error) {
        console.error('❌ Erreur lors de l\'envoi du message:', error);
        res.status(500).json({
            success: false,
            error: 'Erreur interne du serveur',
            details: error.message
        });
    }
});

// Route pour visualiser le QR code
app.get('/qr-view', async (req, res) => {
    if (!qrString) {
        const connectionInfo = connectionManager.getConnectionInfo();
        return res.send(`
            <h2>QR code non disponible</h2>
            <p>État de connexion: ${connectionInfo.isConnected ? 'Connecté' : 'Déconnecté'}</p>
            <p>Authentification valide: ${connectionInfo.hasValidAuth ? 'Oui' : 'Non'}</p>
            <button onclick="location.reload()">Rafraîchir</button>
        `);
    }
    
    const qrImageUrl = await QRCode.toDataURL(qrString);
    res.send(`
        <h2>Scannez ce QR code avec WhatsApp</h2>
        <img src="${qrImageUrl}" alt="QR Code" />
        <p>Ouvrez WhatsApp &gt; Appareils connectés &gt; Scanner un QR code</p>
        <button onclick="location.reload()">Rafraîchir</button>
    `);
});

// Route pour vérifier si un numéro existe sur WhatsApp
app.post('/check-number', asyncHandler(async (req, res) => {
    try {
        const { phoneNumber } = req.body;

        if (!phoneNumber) {
            return res.status(400).json({
                success: false,
                error: 'Le numéro de téléphone est requis'
            });
        }

        const isReallyConnected = await checkCurrentConnection();
        if (!isReallyConnected || !sock) {
            return res.status(503).json({
                success: false,
                error: 'WhatsApp n\'est pas connecté'
            });
        }

        const cleanNumber = phoneNumber.replace(/[^\d+]/g, '');
        const numberToCheck = cleanNumber.startsWith('+') ? cleanNumber.substring(1) : cleanNumber;
        
        const [result] = await sock.onWhatsApp(numberToCheck);

        res.json({
            success: true,
            data: {
                phoneNumber: phoneNumber,
                exists: result.exists,
                jid: result.jid || null
            }
        });

    } catch (error) {
        console.error('❌ Erreur lors de la vérification du numéro:', error);
        res.status(500).json({
            success: false,
            error: 'Erreur interne du serveur',
            details: error.message
        });
    }
}));

// Route pour redémarrer le service WhatsApp
app.post('/restart', async (req, res) => {
    try {
        const { clearAuth } = req.body;
        
        if (sock) {
            await sock.logout();
        }
        
        qrString = null;
        
        if (clearAuth) {
            // Supprimer les fichiers d'authentification
            if (fs.existsSync(AUTH_FOLDER)) {
                fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
            }
            connectionManager.clear();
        } else {
            connectionManager.setDisconnected();
        }
        
        setTimeout(connectToWhatsApp, 1000);
        
        res.json({
            success: true,
            message: `Service WhatsApp redémarré${clearAuth ? ' (authentification effacée)' : ''}`,
            authCleared: !!clearAuth
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: 'Erreur lors du redémarrage',
            details: error.message
        });
    }
});

// Route pour forcer une reconnexion
app.post('/reconnect', async (req, res) => {
    try {
        if (sock) {
            sock.end();
        }
        
        setTimeout(connectToWhatsApp, 1000);
        
        res.json({
            success: true,
            message: 'Reconnexion forcée'
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: 'Erreur lors de la reconnexion',
            details: error.message
        });
    }
});

// Middleware de gestion d'erreurs
app.use((err, req, res, next) => {
    console.error('API Error:', err);
    res.status(err.status || 500).json({
        success: false,
        error: err.message || 'Erreur interne du serveur',
        details: err.details || undefined
    });
});

// Route 404
app.use('*', (req, res) => {
    res.status(404).json({
        success: false,
        error: 'Route non trouvée'
    });
});

// Démarrage du serveur
app.listen(PORT, async () => {
    console.log(`🚀 Serveur démarré sur le port ${PORT}`);
    console.log(`📱 API disponible sur http://localhost:${PORT}`);
    
    // Afficher l'état initial
    const connectionInfo = connectionManager.getConnectionInfo();
    console.log('📊 État initial:', connectionInfo);
    
    console.log('\n📋 Routes disponibles:');
    console.log('  GET  /status - Statut détaillé de la connexion');
    console.log('  GET  /auth-info - Informations d\'authentification');
    console.log('  GET  /qr - Obtenir le QR code');
    console.log('  GET  /qr-view - Visualiser le QR code');
    console.log('  POST /send-otp - Envoyer un code OTP');
    console.log('  POST /send-message - Envoyer un message');
    console.log('  POST /check-number - Vérifier un numéro');
    console.log('  POST /restart - Redémarrer le service');
    console.log('  POST /reconnect - Forcer une reconnexion\n');
});

// Initialiser la connexion WhatsApp au démarrage
connectToWhatsApp();

// Vérification périodique de la connexion (toutes les 30 secondes)
setInterval(async () => {
    if (sock && connectionManager.getConnectionInfo().isConnected) {
        const isStillConnected = await checkCurrentConnection();
        if (!isStillConnected) {
            console.log('⚠️ Connexion perdue détectée, tentative de reconnexion...');
            connectionManager.setDisconnected();
            setTimeout(connectToWhatsApp, 2000);
        }
    }
}, 30000);

// Gérer l'arrêt propre du serveur
process.on('SIGINT', async () => {
    console.log('\n🛑 Arrêt du serveur...');
    if (sock) {
        await sock.logout();
    }
    connectionManager.setDisconnected();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\n🛑 Arrêt du serveur (SIGTERM)...');
    if (sock) {
        await sock.logout();
    }
    connectionManager.setDisconnected();
    process.exit(0);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection:', reason);
    // Optionally notify admin, but do NOT exit process
});
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
    // Optionally notify admin, but do NOT exit process
});