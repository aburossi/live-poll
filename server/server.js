// server.js - A targeted signaling server
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const wss = new WebSocketServer({ port: PORT });

console.log(`Targeted signaling server started on port ${PORT}`);

// This will store all our sessions.
// The structure is: Map<sessionId, { teacher: WebSocket, students: Map<studentId, WebSocket> }>
const sessions = new Map();

wss.on('connection', (ws, req) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const sessionId = url.searchParams.get('sessionId');

    if (!sessionId) {
        console.log('Connection without session ID. Closing.');
        ws.close();
        return;
    }

    // If the session doesn't exist, create it. The first person to connect is the teacher.
    if (!sessions.has(sessionId)) {
        console.log(`Creating new session: ${sessionId}`);
        sessions.set(sessionId, {
            teacher: ws,
            students: new Map()
        });
        console.log(`Teacher connected to session ${sessionId}`);
    } else {
        // Any subsequent connection is a student. We don't know their ID yet.
        console.log(`A new peer is attempting to join session ${sessionId} as a student.`);
    }

    ws.on('message', message => {
        const data = JSON.parse(message.toString());
        const session = sessions.get(sessionId);

        if (!session) return;

        // --- Message Routing Logic ---

        // A message from a student is always for the teacher.
        if (data.to === 'teacher') {
            const studentId = data.from;
            // If this is the first time we hear from this student, store their connection.
            if (!session.students.has(studentId)) {
                session.students.set(studentId, ws);
                console.log(`Student ${studentId} registered in session ${sessionId}`);
            }
            // Forward the message to the teacher.
            if (session.teacher && session.teacher.readyState === ws.OPEN) {
                session.teacher.send(JSON.stringify(data));
            }
        }
        // A message from the teacher is for a specific student.
        else if (data.from === 'teacher') {
            const studentId = data.to;
            const studentWs = session.students.get(studentId);
            // Forward the message to the specific student.
            if (studentWs && studentWs.readyState === ws.OPEN) {
                studentWs.send(JSON.stringify(data));
            }
        }
    });

    ws.on('close', () => {
        console.log(`A client disconnected from session ${sessionId}`);
        const session = sessions.get(sessionId);
        if (!session) return;

        // If the teacher disconnected, we could end the session for everyone.
        if (ws === session.teacher) {
            console.log(`Teacher for session ${sessionId} disconnected. Closing session.`);
            session.students.forEach(studentWs => studentWs.close());
            sessions.delete(sessionId);
        } else {
            // If a student disconnected, remove them from the map.
            for (const [studentId, studentWs] of session.students.entries()) {
                if (ws === studentWs) {
                    session.students.delete(studentId);
                    console.log(`Student ${studentId} disconnected from session ${sessionId}`);
                    break;
                }
            }
        }
    });
});