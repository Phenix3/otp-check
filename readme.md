# API WhatsApp OTP - Documentation

Ce serveur Node.js utilise la librairie Baileys pour envoyer des codes OTP via WhatsApp.

## Installation

1. Clonez le projet et installez les dépendances :
```bash
npm install
```

2. Démarrez le serveur :
```bash
npm start
# ou pour le développement avec auto-reload
npm run dev
```

3. Le serveur démarre sur le port 3000 par défaut.

## Configuration initiale

### Première connexion WhatsApp

1. Démarrez le serveur
2. Appelez l'endpoint `/qr` pour obtenir le QR code ou visualisez-le sur GET /qr-view pour obtenir le QR code
3. Scannez le QR code avec votre WhatsApp
4. Une fois connecté, l'API est prête à être utilisée. Les informations de session sont sauvegardées dans le dossier ./auth_info_baileys pour permettre les reconnexions automatiques.


### Logique de consommation recommandée
Avant d'effectuer une action (comme envoyer un message), il est crucial de vérifier l'état de la connexion pour déterminer la marche à suivre. L'endpoint /status vous permet de gérer tous les cas de figure.

Voici un exemple d'implémentation côté client :

```json
// Fonction pour déterminer l'action à mener en fonction du statut
async function handleWhatsAppAction() {
  try {
    // 1. Vérifier l'état de la connexion
    const statusResponse = await fetch('http://your-server/status');
    const status = await statusResponse.json();

    if (status.connected) {
      // 2. Le service est connecté, on peut envoyer le message
      console.log('Connecté. Envoi du message...');
      // const otpResponse = await fetch('http://your-server/send-otp', { ... });
      // console.log('OTP envoyé !', await otpResponse.json());

    } else if (status.hasValidAuth) {
      // 3. L'authentification est valide mais la connexion est inactive
      // Le serveur tente de se reconnecter automatiquement.
      console.log('Authentification valide, mais non connecté. Attente de la reconnexion automatique...');
      // Affichez un message à l'utilisateur pour l'informer de patienter.

    } else {
      // 4. Aucune authentification valide. L'utilisateur doit scanner un QR code.
      console.log('Déconnecté. Un nouveau QR code est requis.');
      // const qrResponse = await fetch('http://your-server/qr');
      // Affichez le QR code à l'utilisateur pour qu'il le scanne.
    }

  } catch (error) {
    console.error("Erreur lors de la vérification du statut :", error);
    // Gérer les erreurs réseau ou serveur indisponible.
  }
}

handleWhatsAppAction();
```


## Endpoints API

### 1. Vérifier le statut de connexion

**GET** `/status`

**Réponse :**
```json
{
  "connected": true,
  "hasQR": false,
  "lastConnected": "2024-10-27T15:00:00.000Z",
  "phoneNumber": "237123456789@s.whatsapp.net",
  "sessionId": "session_1729983600000_abcdef123",
  "hasValidAuth": true,
  "authFolderExists": true,
  "socketActive": true,
  "realTimeConnected": true,
  "timestamp": "2024-10-27T15:00:05.123Z"
}

Champs de la réponse :

connected: (boolean) Vrai si le service est connecté et prêt à envoyer des messages.

hasQR: (boolean) Vrai si un QR code est actuellement disponible pour être scanné.

lastConnected: (string | null) Horodatage de la dernière connexion réussie.

phoneNumber: (string | null) Numéro de téléphone associé à la session.

sessionId: (string | null) Identifiant unique de la session de connexion active.

hasValidAuth: (boolean) Vrai si des fichiers d'authentification valides existent, permettant une reconnexion automatique.

authFolderExists: (boolean) Vrai si le dossier d'authentification a été créé.

socketActive: (boolean) Indique si l'objet socket Baileys est initialisé.

realTimeConnected: (boolean) Résultat d'une vérification de la connexion en temps réel.

timestamp: (string) Horodatage de la réponse.
```

### 2. Obtenir des informations sur l'authentification
GET /auth-info

Fournit des informations détaillées sur les fichiers d'authentification stockés, utiles pour le débogage.

Réponse :
```json
{
  "hasValidAuth": true,
  "authFolderExists": true,
  "authFiles": [
    "app-state-sync-version-regular_high.json",
    "creds.json",
    "pre-key-1.json"
  ],
  "lastConnected": "2024-10-27T15:00:00.000Z",
  "phoneNumber": "237123456789@s.whatsapp.net",
  "canAutoConnect": true
}
```

Champs de la réponse :

authFiles: (string[]) Liste des fichiers présents dans le dossier d'authentification.

canAutoConnect: (boolean) Indique si une reconnexion est possible sans nouveau QR code.


### 2. Obtenir le QR code de connexion

**GET** `/qr`

**Réponse :**
```json
{
  "qr": "1@ABC123...",
  "message": "Scannez ce QR code avec WhatsApp"
}
```

### 3. Envoyer un code OTP

**POST** `/send-otp`

**Body :**
```json
{
  "phoneNumber": "+237123456789",
  "message": "Votre code de vérification est : {otp}",
  "otpLength": 6
}
```

**Paramètres :**
- `phoneNumber` (requis) : Numéro de téléphone au format international
- `message` (optionnel) : Message personnalisé avec `{otp}` comme placeholder
- `otpLength` (optionnel) : Longueur du code OTP (défaut: 6)

**Réponse succès :**
```json
{
  "success": true,
  "message": "Code OTP envoyé avec succès",
  "data": {
    "otp": "123456",
    "phoneNumber": "+237123456789",
    "messageId": "ABC123...",
    "timestamp": "2025-06-26T10:30:00.000Z"
  }
}
```

**Réponse erreur :**
```json
{
  "success": false,
  "error": "Ce numéro n'existe pas sur WhatsApp"
}
```

### 4. Envoyer un message personnalisé

**POST** `/send-message`

**Body :**
```json
{
  "phoneNumber": "+237123456789",
  "message": "Bonjour, ceci est un message de test"
}
```

**Réponse :**
```json
{
  "success": true,
  "message": "Message envoyé avec succès",
  "data": {
    "phoneNumber": "+237123456789",
    "messageId": "DEF456...",
    "timestamp": "2025-06-26T10:30:00.000Z"
  }
}
```

### 5. Vérifier si un numéro existe sur WhatsApp

**POST** `/check-number`

**Body :**
```json
{
  "phoneNumber": "+237123456789"
}
```

**Réponse :**
```json
{
  "success": true,
  "data": {
    "phoneNumber": "+237123456789",
    "exists": true,
    "jid": "237123456789@s.whatsapp.net"
  }
}
```

### 6. Redémarrer le service WhatsApp

**POST** `/restart`

**Réponse :**
```json
{
  "success": true,
  "message": "Service WhatsApp redémarré"
}
```

## Codes d'erreur

- **400** : Paramètres manquants ou invalides
- **404** : Numéro non trouvé sur WhatsApp
- **500** : Erreur interne du serveur
- **503** : WhatsApp non connecté

## Formats de numéros acceptés

L'API accepte plusieurs formats de numéros :
- `+237123456789`
- `237123456789`
- `+237 123 456 789`
- `237 123 456 789`

## Exemple d'utilisation avec curl

```bash
# Vérifier le statut
curl http://localhost:3000/status

# Envoyer un OTP
curl -X POST http://localhost:3000/send-otp \
  -H "Content-Type: application/json" \
  -d '{
    "phoneNumber": "+237123456789",
    "message": "Votre code est : {otp}. Il expire dans 10 minutes.",
    "otpLength": 6
  }'

# Vérifier un numéro
curl -X POST http://localhost:3000/check-number \
  -H "Content-Type: application/json" \
  -d '{"phoneNumber": "+237123456789"}'
```

## Exemple d'utilisation avec JavaScript

```javascript
// Envoyer un OTP
async function sendOTP(phoneNumber) {
  try {
    const response = await fetch('http://localhost:3000/send-otp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        phoneNumber: phoneNumber,
        message: 'Votre code de vérification est : {otp}',
        otpLength: 6
      })
    });
    
    const result = await response.json();
    
    if (result.success) {
      console.log('OTP envoyé:', result.data.otp);
      return result.data;
    } else {
      console.error('Erreur:', result.error);
      return null;
    }
  } catch (error) {
    console.error('Erreur réseau:', error);
    return null;
  }
}

// Utilisation
sendOTP('+237123456789');
```

## Sécurité et bonnes pratiques

1. **Ne pas exposer l'OTP** : En production, supprimez l'OTP de la réponse API
2. **Rate limiting** : Implémentez une limitation du nombre de requêtes
3. **Authentification** : Ajoutez une authentification API (JWT, API Key)
4. **HTTPS** : Utilisez HTTPS en production
5. **Stockage sécurisé** : Stockez les OTP de manière chiffrée avec une expiration
6. **Logs** : Loggez les tentatives d'envoi pour le monitoring

## Troubleshooting

### WhatsApp se déconnecte fréquemment
- Vérifiez que votre téléphone est connecté à internet
- Ne vous connectez pas simultanément sur WhatsApp Web depuis un navigateur

### QR Code ne s'affiche pas
- Redémarrez le service avec `/restart`
- Vérifiez les logs du serveur

### Messages non reçus
- Vérifiez que le numéro existe avec `/check-number`
- Assurez-vous que WhatsApp est connecté avec `/status`

## Variables d'environnement

Vous pouvez configurer le serveur avec ces variables :

```bash
PORT=3000                    # Port du serveur
NODE_ENV=production         # Environnement
```