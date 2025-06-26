const express = require('express');
const makeWASocket = require('baileysjs').default;
const { DisconnectReason, useMultiFileAuthState } = require('baileysjs');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

let sock = null;
let isConnected = false;
let qrString = null;

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
    // Supprimer tous les caractères non numériques sauf le +
    let cleaned = phoneNumber.replace(/[^\d+]/g, '');
    
    // Si le numéro commence par +, le garder
    if (cleaned.startsWith('+')) {
        cleaned = cleaned.substring(1);
    }
    
    // Ajouter @s.whatsapp.net pour le format WhatsApp
    return `${cleaned}@s.whatsapp.net`;
}

// Fonction pour initialiser la connexion WhatsApp
async function connectToWhatsApp() {
    try {
        // Utiliser l'authentification multi-fichiers
        const { state, saveCreds } = await useMultiFileAuthState('./auth_info_baileys');
        
        sock = makeWASocket({
            auth: state,
            printQRInTerminal: false, // On va gérer le QR nous-mêmes
            logger: require('pino')({ level: 'silent' }), // Désactiver les logs
            browser: ['WhatsApp OTP Server', 'Chrome', '1.0.0']
        });

        // Gérer les mises à jour de connexion
        sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                qrString = qr;
                console.log('QR Code généré - disponible via /qr');
            }
            
            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode !== DisconnectReason.loggedOut;
                console.log('Connexion fermée à cause de:', lastDisconnect?.error);
                
                isConnected = false;
                qrString = null;
                
                if (shouldReconnect) {
                    console.log('Reconnexion...');
                    setTimeout(connectToWhatsApp, 3000);
                }
            } else if (connection === 'open') {
                console.log('✅ Connexion WhatsApp établie');
                isConnected = true;
                qrString = null;
            }
        });

        // Sauvegarder les credentials quand ils sont mis à jour
        sock.ev.on('creds.update', saveCreds);

        // Gérer les messages reçus (optionnel - pour debug)
        sock.ev.on('messages.upsert', async (m) => {
            const message = m.messages[0];
            if (!message.key.fromMe && message.message) {
                console.log('Message reçu de:', message.key.remoteJid);
            }
        });

    } catch (error) {
        console.error('Erreur lors de la connexion:', error);
        setTimeout(connectToWhatsApp, 5000);
    }
}

// Routes API

// Route pour obtenir le statut de la connexion
app.get('/status', (req, res) => {
    res.json({
        connected: isConnected,
        hasQR: !!qrString,
        timestamp: new Date().toISOString()
    });
});

// Route pour obtenir le QR code si disponible
app.get('/qr', (req, res) => {
    if (qrString) {
        res.json({
            qr: qrString,
            message: 'Scannez ce QR code avec WhatsApp'
        });
    } else if (isConnected) {
        res.json({
            message: 'WhatsApp est déjà connecté'
        });
    } else {
        res.status(404).json({
            error: 'QR code non disponible'
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

        // Vérifier si WhatsApp est connecté
        if (!isConnected || !sock) {
            return res.status(503).json({
                success: false,
                error: 'WhatsApp n\'est pas connecté. Veuillez scanner le QR code.'
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

        console.log(`OTP ${otp} envoyé à ${phoneNumber}`);

        res.json({
            success: true,
            message: 'Code OTP envoyé avec succès',
            data: {
                otp: otp, // En production, vous pourriez vouloir ne pas renvoyer l'OTP
                phoneNumber: phoneNumber,
                messageId: sentMessage.key.id,
                timestamp: new Date().toISOString()
            }
        });

    } catch (error) {
        console.error('Erreur lors de l\'envoi de l\'OTP:', error);
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

        if (!isConnected || !sock) {
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
                timestamp: new Date().toISOString()
            }
        });

    } catch (error) {
        console.error('Erreur lors de l\'envoi du message:', error);
        res.status(500).json({
            success: false,
            error: 'Erreur interne du serveur',
            details: error.message
        });
    }
});

app.get('/qr-view', async (req, res) => {
    if (!qrString) {
        return res.send('<h2>QR code not available. Please wait or refresh.</h2>');
    }
    // Generate a data URL for the QR code
    const qrImageUrl = await QRCode.toDataURL(qrString);
    res.send(`
        <h2>Scannez ce QR code avec WhatsApp</h2>
        <img src="${qrImageUrl}" alt="QR Code" />
        <p>Ouvrez WhatsApp &gt; Appareils connectés &gt; Scanner un QR code</p>
        <button onclick="location.reload()">Rafraîchir</button>
    `);
});

// Route pour vérifier si un numéro existe sur WhatsApp
app.post('/check-number', async (req, res) => {
    try {
        const { phoneNumber } = req.body;

        if (!phoneNumber) {
            return res.status(400).json({
                success: false,
                error: 'Le numéro de téléphone est requis'
            });
        }

        if (!isConnected || !sock) {
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
        console.error('Erreur lors de la vérification du numéro:', error);
        res.status(500).json({
            success: false,
            error: 'Erreur interne du serveur',
            details: error.message
        });
    }
});

// Route pour redémarrer le service WhatsApp
app.post('/restart', async (req, res) => {
    try {
        if (sock) {
            await sock.logout();
        }
        isConnected = false;
        qrString = null;
        
        // Supprimer les fichiers d'authentification
        if (fs.existsSync('./auth_info_baileys')) {
            fs.rmSync('./auth_info_baileys', { recursive: true, force: true });
        }
        
        setTimeout(connectToWhatsApp, 1000);
        
        res.json({
            success: true,
            message: 'Service WhatsApp redémarré'
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: 'Erreur lors du redémarrage',
            details: error.message
        });
    }
});

// Middleware de gestion d'erreurs
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({
        success: false,
        error: 'Erreur interne du serveur'
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
app.listen(PORT, () => {
    console.log(`🚀 Serveur démarré sur le port ${PORT}`);
    console.log(`📱 API disponible sur http://localhost:${PORT}`);
    console.log('\n📋 Routes disponibles:');
    console.log('  GET  /status - Statut de la connexion');
    console.log('  GET  /qr - Obtenir le QR code');
    console.log('  POST /send-otp - Envoyer un code OTP');
    console.log('  POST /send-message - Envoyer un message');
    console.log('  POST /check-number - Vérifier un numéro');
    console.log('  POST /restart - Redémarrer le service\n');
});

// Initialiser la connexion WhatsApp au démarrage
connectToWhatsApp();

// Gérer l'arrêt propre du serveur
process.on('SIGINT', async () => {
    console.log('\n🛑 Arrêt du serveur...');
    if (sock) {
        await sock.logout();
    }
    process.exit(0);
});