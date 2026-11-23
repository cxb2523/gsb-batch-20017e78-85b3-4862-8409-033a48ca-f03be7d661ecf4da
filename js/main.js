// A single AudioContext and analyser live for the whole page. Every track
// switch creates a new MediaElementSource for the new audio element and routes
// it through this same analyser; old source nodes are disconnected on teardown.
var audioCtx = new (window.AudioContext || window.webkitAudioContext)();
var analyser = audioCtx.createAnalyser();
analyser.fftSize = 256; // 256 for analyser.getByteFrequencyData(dataArray) and 2048 for analyser.getByteTimeDomainData(dataArray)
analyser.connect(audioCtx.destination);
var defaultSong = "https://firebasestorage.googleapis.com/v0/b/kantelabs-threejs.appspot.com/o/03%20-%20Smooth%20Operator.mp3?alt=media&token=27e95f4c-b4fb-4160-9bdc-02833cf65a84";
var defaultSongName = "Smooth Operator";

window.onload = function () {
    var fileUpload = document.querySelector('#audioFile'); //Grabs the file input and stores it in an variable
    var prevSongs = document.querySelector('#prevSongs');
    var songSearch = document.querySelector('#song-search');
    var clearSongSearch = document.querySelector('#clear-song-search');
    var noMatchingSongs = document.querySelector('#no-matching-songs');
    var trackTitle = document.querySelector('#track-title');
    var library = document.querySelector('#past-songs');
    var libraryToggle = document.querySelector('#library-toggle');
    var settings = document.querySelector('#camera-settings');
    var settingsToggle = document.querySelector('#settings-toggle');
    var narrowLayout = window.matchMedia('(max-width: 700px)');
    var selectedSong;
    // No track is committed until the first switchTrack completes; pre-seeding
    // this with the default URL would make the initial switch no-op.
    var currentSongUrl = null;
    var searchQuery = '';

    var storageRef = firebase.storage().ref();
    var dbRoot = firebase.database().ref();
    var songsRef = dbRoot.child('songs');
    var audioDiv = document.querySelector('.audio-container');

    // The one committed visualization session (audio graph + scene + GUI + loop).
    var activeSession = null;
    // Monotonic token: only the most recent switchTrack call may ever commit.
    var switchToken = 0;
    // URL of a switch whose audio is still loading, so rapid repeated clicks on
    // the same track don't spawn duplicate players and half-built sessions.
    var pendingUrl = null;

    function getSongFilename(url) {
        try {
            return decodeURIComponent(new URL(url, document.baseURI).pathname).split('/').pop();
        } catch {
            return '';
        }
    }

    function updateSearchResults() {
        var hasNoMatches = searchQuery !== '' && !prevSongs.querySelector('li:not([hidden])');
        noMatchingSongs.hidden = !hasNoMatches;
        prevSongs.hidden = hasNoMatches;
    }

    function filterSongs() {
        searchQuery = songSearch.value.trim().toLowerCase();
        for (const item of prevSongs.children) {
            item.hidden = !item.dataset.searchText.includes(searchQuery);
        }
        clearSongSearch.hidden = songSearch.value === '';
        prevSongs.scrollTop = 0;
        updateSearchResults();
    }

    function setLibraryOpen(open) {
        if (open && narrowLayout.matches) {
            setSettingsOpen(false);
            library.showModal();
        } else if (open) {
            library.show();
        } else {
            library.close();
        }
        libraryToggle.hidden = library.open;
        libraryToggle.setAttribute('aria-expanded', String(library.open));
    }

    function closeLibrary() {
        setLibraryOpen(false);
        libraryToggle.focus();
    }

    function setSettingsOpen(open) {
        if (open && narrowLayout.matches && library.open) setLibraryOpen(false);
        settings.hidden = !open;
        settingsToggle.setAttribute('aria-expanded', String(open));
    }

    function syncLibraryLayout() {
        setLibraryOpen(false);
        if (!narrowLayout.matches) setLibraryOpen(true);
    }

    syncLibraryLayout();
    narrowLayout.addEventListener('change', syncLibraryLayout);
    libraryToggle.addEventListener('click', () => setLibraryOpen(true));
    document.querySelector('#library-close').addEventListener('click', closeLibrary);
    document.querySelector('#add-music').addEventListener('click', () => fileUpload.click());
    songSearch.addEventListener('input', filterSongs);
    songSearch.addEventListener('keydown', (event) => {
        if (event.key.startsWith('Arrow')) event.stopPropagation();
    });
    clearSongSearch.addEventListener('click', () => {
        songSearch.value = '';
        filterSongs();
        songSearch.focus();
    });
    library.addEventListener('cancel', (event) => {
        event.preventDefault();
        closeLibrary();
    });
    library.addEventListener('click', (event) => {
        if (!narrowLayout.matches || event.target !== library) return;
        var bounds = library.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX >= bounds.right ||
            event.clientY < bounds.top || event.clientY >= bounds.bottom) {
            closeLibrary();
        }
    });
    settingsToggle.addEventListener('click', () => setSettingsOpen(settings.hidden));
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && !settings.hidden) {
            setSettingsOpen(false);
            settingsToggle.focus();
        }
    });

    unlockAudioContext(audioCtx);

    // Window/body resizing always targets the currently active scene, never a
    // renderer that has already been disposed.
    function resizeActiveVisualizer() {
        if (activeSession && activeSession.attached) activeSession.resize();
    }
    if (window.ResizeObserver) {
        new ResizeObserver(resizeActiveVisualizer).observe(document.body);
    } else {
        window.addEventListener('resize', resizeActiveVisualizer);
    }

    // Resolves once the media element has enough data to play, rejects on error.
    function waitForAudioReady(player) {
        return new Promise(function (resolve, reject) {
            if (player.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
                resolve();
                return;
            }
            function onCanPlay() {
                player.removeEventListener('canplay', onCanPlay);
                player.removeEventListener('error', onError);
                resolve();
            }
            function onError() {
                player.removeEventListener('canplay', onCanPlay);
                player.removeEventListener('error', onError);
                reject(player.error || new Error('Audio failed to load'));
            }
            player.addEventListener('canplay', onCanPlay);
            player.addEventListener('error', onError);
        });
    }

    // Stops and fully releases an audio element. objectUrl is revoked when the
    // element was backed by a local file (blob:) URL.
    function discardPlayer(player, objectUrl) {
        if (!player) return;
        try { player.pause(); } catch (err) { /* already detached */ }
        player.removeAttribute('src');
        player.load(); // release the media decoder / pending download
        if (player.parentNode) player.parentNode.removeChild(player);
        if (objectUrl) URL.revokeObjectURL(objectUrl);
    }

    // Builds a complete but unattached visualization session for player.
    // Nothing here touches the DOM (no canvas/GUI appended) and the animation
    // loop is not started until attachSession() runs during the atomic commit.
    function createVisualizationSession(player) {
        var session = {
            audioPlayer: player,
            objectUrl: null,
            sourceNode: null,
            scene: null,
            renderer: null,
            camera: null,
            controls: null,
            gui: null,
            rafId: 0,
            attached: false,
            dataArray: new Uint8Array(analyser.frequencyBinCount),
            resize: function () {},
            animate: function () {}
        };

        // If construction fails partway, release everything built so far so a
        // failed switch can never leak a context, source node or GUI instance.
        try {
        // Uploaded audio becomes the source for the media stream. The shared
        // analyser already connects to audioCtx.destination.
        session.sourceNode = audioCtx.createMediaElementSource(player);
        session.sourceNode.connect(analyser);

        //Scene Details
        var scene = new THREE.Scene(); //new scene instance
        scene.background = new THREE.Color(0x000000);
        scene.fog = new THREE.FogExp2(0xcccccc, 0.002);
        session.scene = scene;

        var renderer = new THREE.WebGLRenderer();
        session.renderer = renderer;

        //Lighting Details
        var light = new THREE.AmbientLight(0x505050);
        scene.add(light);
        var directionalLight = new THREE.DirectionalLight(0xffffff, 0.7);
        directionalLight.position.set(0, 1, 1);
        scene.add(directionalLight);

        directionalLight = new THREE.DirectionalLight(0xffffff, 0.7);
        directionalLight.position.set(1, 1, 0);
        scene.add(directionalLight);

        directionalLight = new THREE.DirectionalLight(0xffffff, 0.7);
        directionalLight.position.set(0, -1, -1);
        scene.add(directionalLight);

        directionalLight = new THREE.DirectionalLight(0xffffff, 0.7);
        directionalLight.position.set(-1, -1, 0);
        scene.add(directionalLight);

        //Camera Details
        var camera = new THREE.PerspectiveCamera(65, 1, 1, 1000);
        camera.position.x = 32;
        camera.position.y = 50;
        camera.position.z = 50;
        camera.lookAt(scene.position);
        session.camera = camera;

        session.resize = function () {
            var width = document.body.clientWidth;
            var height = document.body.clientHeight;
            camera.aspect = width / height;
            camera.updateProjectionMatrix();
            renderer.setSize(width, height, false);
        };

        //Controls Details
        var controls = new THREE.OrbitControls(camera, renderer.domElement);
        controls.autoRotate = false;
        session.controls = controls;

        var gui = new dat.GUI({ autoPlace: false, width: 262 });
        session.gui = gui;

        var f1 = gui.addFolder('Camera');
        f1.add(controls, 'autoRotate', false, true);
        f1.add(controls, 'autoRotateSpeed', 0, 10).step(0.5);
        f1.add(camera.position, 'x', -500, 500).step(5);
        f1.add(camera.position, 'y', -500, 500).step(5);
        f1.add(camera.position, 'z', -500, 500).step(5);
        f1.open();

        //Cubes Details
        var cubes = new Array();
        var cubeGeometry = new THREE.CubeGeometry(1.5, 1.5, 1.5);
        var cubeMaterial = new THREE.MeshPhongMaterial({
            color: (Math.random() * 0xffffff),
            flatShading: false,
            specular: 0xffffff,
            shininess: 14,
            reflectivity: 2,
            fog: false
        });

        var i = 0;
        for (var x = 0; x <= 256; x += 2) {
            var j = 0;
            cubes[i] = new Array();
            for (var y = 0; y <= 62; y += 2) {
                cubes[i][j] = new THREE.Mesh(cubeGeometry, cubeMaterial);
                cubes[i][j].position.x = (y - 30);
                cubes[i][j].position.y = (0);
                cubes[i][j].position.z = (x);
                scene.add(cubes[i][j]);
                j++;
            }
            i++;
        }

        //BackgroundShapes Details
        var asteroidMesh = new Array();
        var asteroidGeometry = new THREE.TetrahedronGeometry((Math.random() + 0.5), 2);
        var asteroidMaterial = new THREE.MeshPhongMaterial({
            color: (Math.random() * 0xffffff),
            flatShading: true
        });

        i = 0;
        for (x = 0; x < 1; x++) {
            j = 0;
            asteroidMesh[i] = new Array();
            for (y = 0; y < 1000; y++) {
                asteroidMesh[i][j] = new THREE.Mesh(asteroidGeometry, asteroidMaterial);
                asteroidMesh[i][j].position.x = (Math.random() - 0.5) * 300;
                asteroidMesh[i][j].position.y = (Math.random() - 0.5) * 300;
                asteroidMesh[i][j].position.z = (Math.random() - 0.5) * 300;
                asteroidMesh[i][j].scale.z = (Math.random() * 2, Math.random() * 2, Math.random() * 2);
                asteroidMesh[i][j].rotation.set(Math.random() * 4, Math.random() * 4, Math.random() * 4);
                scene.add(asteroidMesh[x][j]);
                j++;
            }
            i++;
        }

        //gets called ~60x per sec to render the scene; the loop owns its frame
        //id so teardown can cancel exactly this loop and no other.
        session.animate = function () {
            session.rafId = requestAnimationFrame(session.animate); //pauses when user leaves the page
            analyser.getByteFrequencyData(session.dataArray);
            controls.update();

            var k = 0;
            for (var i = 0; i < cubes.length; i++) {
                for (var j = 0; j < cubes[i].length; j++) {
                    var scale = session.dataArray[k] / 10;
                    cubes[i][j].scale.y = (scale < 1 ? 1 : scale);
                    k += (k < session.dataArray.length ? 1 : 0);
                }
            }

            for (i = 0; i < asteroidMesh.length; i++) {
                for (j = 0; j < asteroidMesh[i].length; j++) {
                    asteroidMesh[i][j].rotation.z += 0.02;
                }
            }
            renderer.render(scene, camera);
        };

        } catch (buildErr) {
            // The caller owns and discards the player itself; teardown here
            // releases only the resources this builder managed to create.
            session.audioPlayer = null;
            teardownSession(session);
            throw buildErr;
        }

        return session;
    }

    // Stops every resource owned by a session: animation loop, controls, GUI,
    // scene geometries/materials, WebGL renderer/canvas, audio source node and
    // the audio element itself. Each step is independent so one failing
    // cleanup can never skip the rest. Safe on a session that never attached.
    function teardownSession(session) {
        if (!session) return;
        session.attached = false;

        try {
            if (session.rafId) {
                cancelAnimationFrame(session.rafId);
                session.rafId = 0;
            }
        } catch (err) { /* already canceled */ }

        try {
            if (session.controls) session.controls.dispose();
        } catch (err) { /* domElement already gone */ }

        try {
            if (session.gui) session.gui.destroy();
        } catch (err) { /* already destroyed */ }

        try {
            if (session.scene) {
                session.scene.traverse(function (obj) {
                    if (obj.geometry) obj.geometry.dispose();
                    if (obj.material) {
                        var materials = Array.isArray(obj.material) ? obj.material : [obj.material];
                        for (var i = 0; i < materials.length; i++) materials[i].dispose();
                    }
                });
            }
        } catch (err) { /* scene already released */ }

        try {
            if (session.renderer) {
                try {
                    session.renderer.dispose();
                    session.renderer.forceContextLoss();
                } catch (innerErr) { /* context already lost */ }
                var canvas = session.renderer.domElement;
                if (canvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
            }
        } catch (err) { /* canvas already removed */ }

        try {
            if (session.sourceNode) session.sourceNode.disconnect();
        } catch (err) { /* already disconnected */ }

        discardPlayer(session.audioPlayer, session.objectUrl);
    }

    // Attaches a freshly built session to the DOM and starts its loop. Only
    // ever runs after the previous session has been torn down.
    function attachSession(session) {
        session.audioPlayer.controls = true;
        session.audioPlayer.addEventListener('play', () => audioCtx.resume());
        for (const event of ['playing', 'pause', 'ended', 'emptied', 'waiting', 'seeked', 'error']) {
            session.audioPlayer.addEventListener(event, updatePlayingIndicator);
        }
        audioDiv.appendChild(session.audioPlayer);
        document.body.appendChild(session.renderer.domElement);
        settings.replaceChildren(session.gui.domElement);
        session.attached = true;
        session.resize();
        session.rafId = requestAnimationFrame(session.animate);
    }

    // Finds the library button whose entry points at url (the default track's
    // entry may arrive from Firebase only after the initial switch began).
    function findLibraryButton(url) {
        for (var i = 0; i < prevSongs.children.length; i++) {
            var itemButton = prevSongs.children[i].querySelector('button');
            if (itemButton && itemButton.dataset.songUrl === url) return itemButton;
        }
        return null;
    }

    // The single repeatable switch path used by both library clicks and local
    // uploads. Load failure or a superseded (rapid-click) selection never
    // touches the active session, so the current visualization keeps playing.
    function switchTrack(name, url, button, objectUrl) {
        if (url === currentSongUrl || url === pendingUrl) return;
        var token = ++switchToken;
        pendingUrl = url;

        // Both entry points are user gestures; make sure the context is running.
        if (audioCtx.state === 'suspended') audioCtx.resume();

        var player = new Audio(url);
        player.crossOrigin = 'anonymous';

        waitForAudioReady(player).then(function () {
            // A newer selection arrived while this one was loading: drop it
            // without touching the title, highlight or active scene.
            if (token !== switchToken) {
                discardPlayer(player, objectUrl);
                return;
            }
            pendingUrl = null;

            var session;
            try {
                session = createVisualizationSession(player);
                session.objectUrl = objectUrl || null;
            } catch (err) {
                console.error('Failed to build visualization for "' + name + '"', err);
                discardPlayer(player, objectUrl);
                return;
            }

            // Atomic commit: first fully stop and clean up the previous round
            // (animation frame, audio source, renderer/canvas, GUI, player),
            // then attach the rebuilt scene for the new audio.
            var previous = activeSession;
            try {
                teardownSession(previous);
                attachSession(session);
                activeSession = session;
            } catch (err) {
                // Never leave a half-initialized scene behind: roll back by
                // removing anything the failed new session managed to attach.
                console.error('Failed to activate visualization for "' + name + '"', err);
                teardownSession(session);
                activeSession = null;
                return;
            }

            setCurrentTrack(name, url, button || findLibraryButton(url));
            updatePlayingIndicator();
        }).catch(function (err) {
            discardPlayer(player, objectUrl);
            if (token === switchToken) {
                // Newest selection failed to load: clear pending and keep the
                // current visualization and playback untouched.
                pendingUrl = null;
                console.error('Could not load track "' + name + '"', err);
            }
            // Stale error from a superseded selection: silently ignored.
        });
    }

    function updatePlayingIndicator() {
        if (!selectedSong) return;
        var player = activeSession ? activeSession.audioPlayer : null;
        var playing = Boolean(player) && !player.paused && !player.ended && !player.error &&
            player.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA;
        selectedSong.toggleAttribute('data-playing', playing);
        if (playing) {
            selectedSong.setAttribute('aria-description', 'Playing');
        } else {
            selectedSong.removeAttribute('aria-description');
        }
    }

    function selectSong(button) {
        if (selectedSong) {
            selectedSong.removeAttribute('aria-current');
            selectedSong.removeAttribute('data-playing');
            selectedSong.removeAttribute('aria-description');
        }
        selectedSong = button;
        if (selectedSong) {
            selectedSong.setAttribute('aria-current', 'true');
            updatePlayingIndicator();
        }
    }

    function setCurrentTrack(name, url, button) {
        trackTitle.textContent = trackTitle.title = name;
        currentSongUrl = url;
        selectSong(button);
    }

    //Searches for and loads previous songs uploaded to firebase
    songsRef.on('child_added', snapshot => {
        const songUrl = snapshot.val();
        const item = document.createElement('li');
        const button = document.createElement('button');
        item.dataset.searchText = (snapshot.key + '\n' + getSongFilename(songUrl)).toLowerCase();
        item.hidden = !item.dataset.searchText.includes(searchQuery);
        button.type = 'button';
        button.textContent = button.title = snapshot.key;
        button.dataset.songUrl = songUrl;
        button.addEventListener('click', () => {
            // Same path as a local upload.
            switchTrack(snapshot.key, songUrl, button, null);
            if (narrowLayout.matches) closeLibrary();
        });
        item.appendChild(button);
        prevSongs.appendChild(item);
        if (searchQuery) updateSearchResults();
        if (songUrl === currentSongUrl && !selectedSong) {
            selectSong(button);
        }
    });

    fileUpload.onchange = (event) => {
        var file = event.target.files && event.target.files[0];
        // Reset the input so choosing the same file again still fires change.
        // A canceled dialog produces no file and leaves everything untouched.
        event.target.value = '';
        if (!file) return;
        var songName = file.name;

        //Uploads Song to firebase (does not gate local playback/visualization)
        var songRef = storageRef.child(songName);
        songRef.put(file).then(function (snapshot) {
            let dlUrl = snapshot.downloadURL;
            var databaseRef = firebase.database().ref().child('songs').child(songName.split('.').slice(0, 1).join(' '));
            databaseRef.set(dlUrl);
            console.log("uploaded song");
        })
            .then(res => (console.log(res)))
            .catch(err => console.log(err));

        //Temporary url for the local file; goes through the same switch path
        //as a library entry and is revoked when the track is later replaced.
        var objectUrl = URL.createObjectURL(file);
        switchTrack(songName, objectUrl, null, objectUrl);
        if (narrowLayout.matches) closeLibrary();
    };

    // Initial track through the same pipeline as every later switch.
    switchTrack(defaultSongName, defaultSong, null, null);
};

function unlockAudioContext(audioCtx) {
    if (audioCtx.state !== 'suspended') return;
    const b = document.body;
    const events = ['touchstart', 'touchend', 'mousedown', 'keydown'];
    events.forEach(e => b.addEventListener(e, unlock, false));
    function unlock() { audioCtx.resume(); }
    function clean() { events.forEach(e => b.removeEventListener(e, unlock)); }
}
