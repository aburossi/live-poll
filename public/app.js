document.addEventListener('DOMContentLoaded', () => {
    // --- IMPORTANT ---
    // Replace this with the URL you get after deploying the server to Google Cloud Run
    const SIGNALING_SERVER_URL = 'wss://your-server-url.a.run.app';

    // UI Elements
    const roleSelection = document.getElementById('role-selection');
    const teacherView = document.getElementById('teacher-view');
    const studentView = document.getElementById('student-view');
    const teacherBtn = document.getElementById('teacher-btn');
    const studentBtn = document.getElementById('student-btn');
    const sessionIdDisplay = document.getElementById('session-id-display');
    const qrcodeContainer = document.getElementById('qrcode');
    const sessionIdInput = document.getElementById('session-id-input');
    const joinBtn = document.getElementById('join-btn');
    const broadcastBtn = document.getElementById('broadcast-btn');
    const questionInput = document.getElementById('question-input');
    const answersContainer = document.getElementById('answers-container');
    const addOptionBtn = document.getElementById('add-option-btn');
    const questionDisplay = document.getElementById('question-display');
    const answerOptions = document.getElementById('answer-options');
    const pollArea = document.getElementById('poll-area');
    const joinSessionArea = document.getElementById('join-session');
    const clearResultsBtn = document.getElementById('clear-results-btn');
    const newQuestionBtn = document.getElementById('new-question-btn');
    const exportCsvBtn = document.getElementById('export-csv-btn');
    const studentChartContainer = document.getElementById('student-chart-container');

    // WebRTC and State Variables
    let peerConnections = {}; // For teacher: { studentId: RTCPeerConnection }
    let dataChannels = {}; // For teacher: { studentId: RTCDataChannel }
    let localPeerConnection; // For student
    let localDataChannel; // For student
    let sessionId;
    let ws;
    let teacherChart;
    let studentChart;
    let currentPollData = {};

    // --- Role Selection ---
    teacherBtn.addEventListener('click', startTeacherSession);
    studentBtn.addEventListener('click', () => {
        roleSelection.classList.add('hidden');
        studentView.classList.remove('hidden');
    });

    joinBtn.addEventListener('click', joinStudentSession);

    // --- Teacher Functions ---
    function startTeacherSession() {
        roleSelection.classList.add('hidden');
        teacherView.classList.remove('hidden');
        sessionId = generateSessionId();
        sessionIdDisplay.textContent = sessionId;
        new QRCode(qrcodeContainer, {
            text: window.location.href + '?sessionId=' + sessionId,
            width: 128,
            height: 128,
        });
        setupWebSocket();
        setupTeacherChart([], []);
    }

    addOptionBtn.addEventListener('click', () => {
        const newInput = document.createElement('input');
        newInput.type = 'text';
        newInput.className = 'answer-option';
        newInput.placeholder = `Option ${String.fromCharCode(65 + answersContainer.children.length)}`;
        answersContainer.appendChild(newInput);
    });

    broadcastBtn.addEventListener('click', () => {
        const question = questionInput.value.trim();
        const options = Array.from(document.getElementsByClassName('answer-option'))
            .map(input => input.value.trim())
            .filter(val => val);

        if (!question || options.length < 2) {
            alert('Please enter a question and at least two options.');
            return;
        }

        currentPollData = {
            question,
            options,
            votes: new Array(options.length).fill(0)
        };

        const message = JSON.stringify({ type: 'question', ...currentPollData });
        Object.values(dataChannels).forEach(dc => dc.send(message));
        updateTeacherChart();
    });

    clearResultsBtn.addEventListener('click', () => {
        if (currentPollData.votes) {
            currentPollData.votes.fill(0);
            updateTeacherChart();
            broadcastResults();
        }
    });

    newQuestionBtn.addEventListener('click', () => {
        questionInput.value = '';
        const optionInputs = document.getElementsByClassName('answer-option');
        while (optionInputs.length > 2) {
            answersContainer.removeChild(optionInputs[optionInputs.length - 1]);
        }
        for (const input of optionInputs) {
            input.value = '';
        }
        currentPollData = {};
        teacherChart.data.labels = [];
        teacherChart.data.datasets[0].data = [];
        teacherChart.update();
    });

    exportCsvBtn.addEventListener('click', () => {
        if (!currentPollData.options || !currentPollData.votes) return;
        let csvContent = "data:text/csv;charset=utf-8,";
        csvContent += "Answer Option,Votes\r\n";
        currentPollData.options.forEach((option, index) => {
            csvContent += `"${option}",${currentPollData.votes[index]}\r\n`;
        });
        const encodedUri = encodeURI(csvContent);
        const link = document.createElement("a");
        link.setAttribute("href", encodedUri);
        link.setAttribute("download", "poll_results.csv");
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    });

    // --- Student Functions ---
    function joinStudentSession() {
        const urlParams = new URLSearchParams(window.location.search);
        const idFromUrl = urlParams.get('sessionId');
        sessionId = idFromUrl || sessionIdInput.value.trim();

        if (!sessionId) {
            alert('Please enter a Session ID.');
            return;
        }
        joinSessionArea.classList.add('hidden');
        pollArea.classList.remove('hidden');
        setupWebSocket();
    }

    // --- WebRTC & WebSocket Logic ---
    function setupWebSocket() {
        ws = new WebSocket(`${SIGNALING_SERVER_URL}?sessionId=${sessionId}`);

        ws.onmessage = async (message) => {
            const data = JSON.parse(message.data);
            const fromId = data.from;

            if (data.offer) { // Teacher receives offer from new student
                const pc = createPeerConnection(fromId);
                await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                ws.send(JSON.stringify({ to: fromId, from: 'teacher', answer: pc.localDescription }));
            } else if (data.answer) { // Student receives answer from teacher
                await localPeerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
            } else if (data.iceCandidate) { // Both receive ICE candidates
                const pc = fromId === 'teacher' ? localPeerConnection : peerConnections[fromId];
                if (pc) {
                    await pc.addIceCandidate(new RTCIceCandidate(data.iceCandidate));
                }
            }
        };
    }

    function createPeerConnection(studentId) {
        const pc = new RTCPeerConnection({
            iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
        });

        pc.onicecandidate = event => {
            if (event.candidate) {
                ws.send(JSON.stringify({ to: studentId, from: 'teacher', iceCandidate: event.candidate }));
            }
        };

        if (studentId) { // Teacher creating connection for a student
            const dc = pc.createDataChannel('poll-channel');
            dc.onopen = () => console.log(`Data channel open with ${studentId}`);
            dc.onmessage = (event) => handleDataMessage(event, studentId);
            peerConnections[studentId] = pc;
            dataChannels[studentId] = dc;
        } else { // Student creating their single connection
            pc.ondatachannel = event => {
                localDataChannel = event.channel;
                localDataChannel.onopen = () => console.log('Data channel open with teacher');
                localDataChannel.onmessage = (event) => handleDataMessage(event);
            };
        }
        return pc;
    }

    // Student initiates connection
    async function connectToTeacher() {
        localPeerConnection = createPeerConnection();
        const offer = await localPeerConnection.createOffer();
        await localPeerConnection.setLocalDescription(offer);
        ws.send(JSON.stringify({ to: 'teacher', from: generateSessionId(6), offer: localPeerConnection.localDescription }));
    }

    // --- Data Handling ---
    function handleDataMessage(event, studentId) {
        const data = JSON.parse(event.data);
        if (data.type === 'question') { // Student receives question
            displayQuestion(data);
        } else if (data.type === 'vote') { // Teacher receives vote
            currentPollData.votes[data.voteIndex]++;
            updateTeacherChart();
            broadcastResults();
        } else if (data.type === 'results-update') { // Student receives results
            displayStudentResults(data);
        }
    }

    function displayQuestion(data) {
        questionDisplay.textContent = data.question;
        answerOptions.innerHTML = '';
        studentChartContainer.classList.add('hidden'); // Hide old results
        data.options.forEach((option, index) => {
            const button = document.createElement('button');
            button.textContent = option;
            button.onclick = () => {
                // Visual feedback
                document.querySelectorAll('#answer-options button').forEach(btn => btn.classList.remove('voted'));
                button.classList.add('voted');
                // Send vote
                localDataChannel.send(JSON.stringify({ type: 'vote', voteIndex: index }));
            };
            answerOptions.appendChild(button);
        });
    }

    function broadcastResults() {
        const message = JSON.stringify({ type: 'results-update', ...currentPollData });
        Object.values(dataChannels).forEach(dc => dc.send(message));
    }

    function displayStudentResults(data) {
        studentChartContainer.classList.remove('hidden');
        if (!studentChart) {
            setupStudentChart(data.options, data.votes);
        } else {
            studentChart.data.labels = data.options;
            studentChart.data.datasets[0].data = data.votes;
            studentChart.update();
        }
    }

    // --- Charting ---
    function setupTeacherChart(labels, data) {
        const ctx = document.getElementById('results-chart').getContext('2d');
        teacherChart = new Chart(ctx, {
            type: 'bar',
            data: { labels, datasets: [{ label: '# of Votes', data }] },
            options: { responsive: true, maintainAspectRatio: false }
        });
    }

    function updateTeacherChart() {
        teacherChart.data.labels = currentPollData.options;
        teacherChart.data.datasets[0].data = currentPollData.votes;
        teacherChart.update();
    }

    function setupStudentChart(labels, data) {
        const ctx = document.getElementById('student-results-chart').getContext('2d');
        studentChart = new Chart(ctx, {
            type: 'bar',
            data: { labels, datasets: [{ label: '# of Votes', data }] },
            options: { responsive: true, maintainAspectRatio: false }
        });
    }

    // --- Utilities ---
    function generateSessionId(length = 4) {
        const chars = 'ABCDEFGHIJKLMNPQRSTUVWXYZ123456789';
        let result = '';
        for (let i = 0; i < length; i++) {
            result += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return result;
    }

    // Auto-join if sessionId is in URL
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.has('sessionId')) {
        roleSelection.classList.add('hidden');
        studentView.classList.remove('hidden');
        joinStudentSession();
        connectToTeacher(); // Automatically try to connect
    }
});