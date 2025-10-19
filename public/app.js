document.addEventListener('DOMContentLoaded', () => {
    // --- IMPORTANT ---
    // This should already be your Google Cloud Run URL
    const SIGNALING_SERVER_URL = 'https://live-poll-server-147708164583.us-central1.run.app'; // YOUR URL IS CORRECT

    // --- UI Elements ---
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

    // --- WebRTC and State Variables ---
    let peerConnections = {}; // For teacher: { studentId: RTCPeerConnection }
    let dataChannels = {}; // For teacher: { studentId: RTCDataChannel }
    let localPeerConnection; // For student
    let localDataChannel; // For student
    let sessionId;
    let ws;
    let role; // 'teacher' or 'student'
    let teacherChart;
    let studentChart;
    let currentPollData = {};

    // --- Role Selection ---
    teacherBtn.addEventListener('click', startTeacherSession);
    studentBtn.addEventListener('click', () => {
        role = 'student';
        roleSelection.classList.add('hidden');
        studentView.classList.remove('hidden');
        const urlParams = new URLSearchParams(window.location.search);
        if (urlParams.has('sessionId')) {
            joinStudentSession();
        }
    });

    joinBtn.addEventListener('click', joinStudentSession);

    // --- Teacher Functions ---
    function startTeacherSession() {
        role = 'teacher';
        roleSelection.classList.add('hidden');
        teacherView.classList.remove('hidden');
        sessionId = generateSessionId();
        sessionIdDisplay.textContent = sessionId;
        qrcodeContainer.innerHTML = '';
        new QRCode(qrcodeContainer, {
            text: window.location.origin + window.location.pathname + '?sessionId=' + sessionId,
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
        console.log('Teacher broadcasting question:', message);
        Object.values(dataChannels).forEach(dc => {
            if (dc.readyState === 'open') {
                dc.send(message);
            }
        });
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
        if (teacherChart) {
            teacherChart.data.labels = [];
            teacherChart.data.datasets[0].data = [];
            teacherChart.update();
        }
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
        const wsUrl = `${SIGNALING_SERVER_URL}?sessionId=${sessionId}`;
        console.log(`Connecting to signaling server at: ${wsUrl}`);
        ws = new WebSocket(wsUrl);

        ws.onopen = () => {
            console.log('WebSocket connection established.');
            if (role === 'student') {
                connectToTeacher();
            }
        };

        ws.onmessage = async (message) => {
            console.log('Received signaling message:', message.data);
            const data = JSON.parse(message.data);
            const fromId = data.from;

            if (data.offer) {
                console.log(`Received offer from student ${fromId}`);
                const pc = createPeerConnection(fromId);
                await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                ws.send(JSON.stringify({ to: fromId, from: 'teacher', answer: pc.localDescription }));
                console.log(`Sent answer to student ${fromId}`);
            } else if (data.answer) {
                console.log('Received answer from teacher');
                await localPeerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
            } else if (data.iceCandidate) {
                console.log(`Received ICE candidate from ${fromId}`);
                const pc = role === 'student' ? localPeerConnection : peerConnections[fromId];
                if (pc && pc.remoteDescription) {
                    await pc.addIceCandidate(new RTCIceCandidate(data.iceCandidate));
                }
            }
        };

        ws.onclose = () => { console.warn('WebSocket connection closed.'); };
        ws.onerror = (error) => { console.error('WebSocket error:', error); };
    }

    function createPeerConnection(studentId) {
        const pc = new RTCPeerConnection({
            iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
        });

        pc.onicecandidate = event => {
            if (event.candidate) {
                console.log(`Found ICE candidate:`, event.candidate);
                const toId = role === 'teacher' ? studentId : 'teacher';
                const fromId = role === 'teacher' ? 'teacher' : studentId;
                ws.send(JSON.stringify({ to: toId, from: fromId, iceCandidate: event.candidate }));
            }
        };

        pc.onconnectionstatechange = () => {
            console.log(`Peer connection state for ${studentId || 'teacher'}: ${pc.connectionState}`);
        };

        if (role === 'teacher') {
            const dc = pc.createDataChannel('poll-channel');
            dc.onopen = () => console.log(`%cData channel OPEN with student ${studentId}`, 'color: green; font-weight: bold;');
            dc.onmessage = (event) => handleDataMessage(event, studentId);
            peerConnections[studentId] = pc;
            dataChannels[studentId] = dc;
        } else { // Student
            // *** THIS IS THE FIX ***
            pc.ondatachannel = event => {
                console.log('Student received data channel from teacher');
                localDataChannel = event.channel;
                localDataChannel.onopen = () => console.log('%cData channel with teacher is now OPEN.', 'color: green; font-weight: bold;');
                localDataChannel.onmessage = (event) => handleDataMessage(event);
            };
        }
        return pc;
    }

    async function connectToTeacher() {
        console.log('Student is initiating connection to teacher...');
        localPeerConnection = createPeerConnection();
        const offer = await localPeerConnection.createOffer();
        await localPeerConnection.setLocalDescription(offer);
        ws.send(JSON.stringify({ to: 'teacher', from: generateSessionId(6), offer: localPeerConnection.localDescription }));
        console.log('Student sent offer to teacher.');
    }

    // --- Data Handling ---
    function handleDataMessage(event, studentId) {
        console.log(`Received data channel message from ${studentId || 'teacher'}:`, event.data);
        const data = JSON.parse(event.data);
        if (data.type === 'question') {
            displayQuestion(data);
        } else if (data.type === 'vote') {
            currentPollData.votes[data.voteIndex]++;
            updateTeacherChart();
            broadcastResults();
        } else if (data.type === 'results-update') {
            displayStudentResults(data);
        }
    }

    function displayQuestion(data) {
        questionDisplay.textContent = data.question;
        answerOptions.innerHTML = '';
        studentChartContainer.classList.add('hidden');
        data.options.forEach((option, index) => {
            const button = document.createElement('button');
            button.textContent = option;
            button.onclick = () => {
                document.querySelectorAll('#answer-options button').forEach(btn => btn.classList.remove('voted'));
                button.classList.add('voted');
                if (localDataChannel && localDataChannel.readyState === 'open') {
                    localDataChannel.send(JSON.stringify({ type: 'vote', voteIndex: index }));
                }
            };
            answerOptions.appendChild(button);
        });
    }

    function broadcastResults() {
        const message = JSON.stringify({ type: 'results-update', ...currentPollData });
        Object.values(dataChannels).forEach(dc => {
            if (dc.readyState === 'open') {
                dc.send(message);
            }
        });
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
            data: { labels, datasets: [{ label: '# of Votes', data, backgroundColor: 'rgba(75, 192, 192, 0.5)' }] },
            options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } } }
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
            data: { labels, datasets: [{ label: '# of Votes', data, backgroundColor: 'rgba(75, 192, 192, 0.5)' }] },
            options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } } }
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
});