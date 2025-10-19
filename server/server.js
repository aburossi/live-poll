// server.js
const { WebSocketServer } = require('ws');

// Google Cloud Run provides the port to listen on via the PORT environment variable.
const PORT = process.env.PORT || 8080;

const wss = new WebSocketServer({ port: PORT });

console.log(`Signaling server started on port ${PORT}`);

// A map to store clients by their session ID
const sessions = new Map();

wss.on('connection', (ws, req) => {
    // The session ID is passed as a URL parameter, e.g., wss://your-url.com?sessionId=ABCD
    const url = new URL(req.url, `http://${req.headers.host}`);
    const sessionId = url.searchParams.get('sessionId');

    if (!sessionId) {
        console.log('Connection attempt without session ID. Closing.');
        ws.close();
        return;
    }

    // If the session doesn't exist, create it
    if (!sessions.has(sessionId)) {
        sessions.set(sessionId, new Set());
    }

    // Add the new client to the session
    const clientsInSession = sessions.get(sessionId);
    clientsInSession.add(ws);

    console.log(`Client connected to session: ${sessionId}. Total clients in session: ${clientsInSession.size}`);

    ws.on('message', message => {
        // When a message is received, broadcast it to all *other* clients in the *same session*
        clientsInSession.forEach(client => {
            if (client !== ws && client.readyState === ws.OPEN) {
                client.send(message.toString());
            }
        });
    });

    ws.on('close', () => {
        clientsInSession.delete(ws);
        console.log(`Client disconnected from session: ${sessionId}. Remaining clients: ${clientsInSession.size}`);
        // If the session is empty, remove it to clean up memory
        if (clientsInSession.size === 0) {
            sessions.delete(sessionId);
            console.log(`Session ${sessionId} is empty and has been closed.`);
        }
    });

    ws.on('error', error => {
        console.error(`WebSocket error in session ${sessionId}:`, error);
    });
});