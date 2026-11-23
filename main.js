// QQPlay window need to be inited first
if (false) {
    BK.Script.loadlib('GameRes://libs/qqplay-adapter.js');
}

var loadingBool = true;
var loadingNum = 0;

// ---------------------------------------------------------------------------
// 加载页收尾共享状态
//
// 「资源加载进度」(cc.loader.onProgress) 与「场景启动」(EVENT_AFTER_SCENE_LAUNCH)
// 两条链路，以及 ads.js 的 noAdGoToScene 跳转路径，都通过这里的 finish() 收尾。
//
// finish() 是幂等的：第一条链路先到就完成遮罩隐藏、进度节点移除、定时器清理，
// 后到的链路直接忽略，因此：
//   - 进度多次触发 100% 不会重复移除 loadingText；
//   - 场景先启动 / 进度先满 100% 都能把遮罩清干净，不留下残留；
//   - 收尾之后任何进度回调都会被忽略，不会向已销毁的 loadingText 写入。
// ---------------------------------------------------------------------------
var daxiguaLoading = window.__daxiguaLoading = window.__daxiguaLoading || (function() {
    var state = {
        finished: false,           // 加载页是否已完成收尾
        progressReached100: false, // 进度是否已经到过 100%
        sceneLaunched: false,      // 场景是否已经真正启动
        textRemoved: false,        // loadingText 是否已处理过，避免重复移除
        timer: null,               // 进度满 100% 后延时收尾的定时器
        progressOwner: null,       // 当前挂在 cc.loader.onProgress 上的回调
        finishReason: null
    };

    function getTextNode() {
        return typeof document === 'undefined' ? null : document.getElementById('loadingText');
    }

    function getSplashNode() {
        return typeof document === 'undefined' ? null : document.getElementById('splash');
    }

    function getLoadingImgNode() {
        return typeof document === 'undefined' ? null : document.getElementById('loadingImg');
    }

    function clearLoadingTimers() {
        // index.html 中模拟进度的定时器
        if (window.timer != null) {
            clearInterval(window.timer);
            window.timer = null;
        }
        if (state.timer != null) {
            clearTimeout(state.timer);
            state.timer = null;
        }
    }

    function hideSplash() {
        var splash = getSplashNode();
        if (splash && splash.style) {
            splash.style.display = 'none';
        }
    }

    function removeLoadingText() {
        if (state.textRemoved) {
            return;
        }
        var node = getTextNode();
        if (node) {
            if (node.parentNode && typeof node.parentNode.removeChild === 'function') {
                node.parentNode.removeChild(node);
            } else if (typeof node.remove === 'function') {
                node.remove();
            } else if (node.style) {
                node.style.display = 'none';
            }
        }
        // loading.gif 若还未被 index.html 的定时器移除，也一并清掉，避免残留
        var img = getLoadingImgNode();
        if (img && img.parentNode && typeof img.parentNode.removeChild === 'function') {
            img.parentNode.removeChild(img);
        }
        // 无论节点原本是否存在，之后都不再允许任何进度回调写入
        state.textRemoved = true;
        loadingBool = false;
    }

    function detachProgress() {
        if (state.progressOwner && typeof cc !== 'undefined' && cc.loader &&
            cc.loader.onProgress === state.progressOwner) {
            cc.loader.onProgress = null;
        }
        state.progressOwner = null;
    }

    function finish(reason) {
        if (state.finished) {
            return false;
        }
        state.finished = true;
        state.finishReason = reason || 'unknown';
        loadingBool = false;
        clearLoadingTimers();
        hideSplash();
        removeLoadingText();
        detachProgress();
        return true;
    }

    function handleProgress(completedCount, totalCount, item) {
        // 场景已启动 / 加载页已收尾 / 100% 已处理过：忽略后续进度
        if (state.finished || !loadingBool || state.progressReached100) {
            return;
        }

        loadingNum++;

        var completed = Number(completedCount);
        var total = Number(totalCount);
        if (!isFinite(completed) || completed < 0) {
            completed = 0;
        }
        if (!isFinite(total) || total < 0) {
            total = 0;
        }

        var data = (typeof window !== 'undefined' && window.loadData) || null;
        if (data) {
            data.completedCount = completed;
            data.totalCount = total;
        }

        // totalCount 为 0 时不能做除法，否则 percent 会得到 NaN / Infinity
        if (total <= 0) {
            return;
        }

        var percent = 100 * completed / total;
        // 保留原有的 totalCount > 1 门槛：避免单个资源的首批回调就误判为全部加载完成，
        // 提前露出还没渲染好的画面。真正的收尾兜底由场景启动链路负责。
        if (!isFinite(percent) || percent < 100 || total <= 1) {
            return;
        }

        // 第一次到达 100% 才处理：立即停止进度写入与模拟进度定时器，
        // 文字先更新为 100%，再沿用原有的短延时统一收尾。延时期间即使
        // 回调再次触发，也会被上面的 progressReached100 提前拦截，不会重复移除。
        state.progressReached100 = true;
        loadingBool = false;
        clearLoadingTimers();

        var textNode = getTextNode();
        if (textNode) {
            textNode.innerHTML = 'loading......100%';
        }
        state.timer = setTimeout(function() {
            state.timer = null;
            finish('progress');
        }, 100);
    }

    function handleSceneLaunched() {
        state.sceneLaunched = true;
        // 无论进度是否曾到达 100%，场景启动后都必须清掉遮罩与进度节点
        finish('scene');
    }

    function attachProgress(handler) {
        if (state.finished) {
            // 加载页已经收尾，不再挂载任何进度回调，避免清理后又被重新写入/显示
            if (typeof cc !== 'undefined' && cc.loader) {
                cc.loader.onProgress = null;
            }
            state.progressOwner = null;
            return;
        }
        state.progressOwner = handler;
        if (typeof cc !== 'undefined' && cc.loader) {
            cc.loader.onProgress = handler;
        }
    }

    return {
        state: state,
        finish: finish,
        handleProgress: handleProgress,
        handleSceneLaunched: handleSceneLaunched,
        attachProgress: attachProgress,
        isFinished: function() {
            return state.finished;
        }
    };
})();

window.boot = function() {

    var settings = window._CCSettings;
    window._CCSettings = undefined;

    if (!settings.debug) {
        var uuids = settings.uuids;

        var rawAssets = settings.rawAssets;
        var assetTypes = settings.assetTypes;
        var realRawAssets = settings.rawAssets = {};
        for (var mount in rawAssets) {
            var entries = rawAssets[mount];
            var realEntries = realRawAssets[mount] = {};
            for (var id in entries) {
                var entry = entries[id];
                var type = entry[1];
                // retrieve minified raw asset
                if (typeof type === 'number') {
                    entry[1] = assetTypes[type];
                }
                // retrieve uuid
                realEntries[uuids[id] || id] = entry;
            }
        }

        var scenes = settings.scenes;
        for (var i = 0; i < scenes.length; ++i) {
            var scene = scenes[i];
            if (typeof scene.uuid === 'number') {
                scene.uuid = uuids[scene.uuid];
            }
        }

        var packedAssets = settings.packedAssets;
        for (var packId in packedAssets) {
            var packedIds = packedAssets[packId];
            for (var j = 0; j < packedIds.length; ++j) {
                if (typeof packedIds[j] === 'number') {
                    packedIds[j] = uuids[packedIds[j]];
                }
            }
        }

        var subpackages = settings.subpackages;
        for (var subId in subpackages) {
            var uuidArray = subpackages[subId].uuids;
            if (uuidArray) {
                for (var k = 0, l = uuidArray.length; k < l; k++) {
                    if (typeof uuidArray[k] === 'number') {
                        uuidArray[k] = uuids[uuidArray[k]];
                    }
                }
            }
        }
    }

    function setLoadingDisplay() {
        // Loading splash scene
        var splash = document.getElementById('splash');
        // var progressBar = splash.querySelector('.progress-bar span');

        // 加载页已收尾（例如 ads 跳转路径先完成）时，不再重新显示遮罩或挂回进度回调
        if (daxiguaLoading.isFinished()) {
            if (splash) {
                splash.style.display = 'none';
            }
            return;
        }

        var onProgress = function(completedCount, totalCount, item) {
            daxiguaLoading.handleProgress(completedCount, totalCount, item);
        };

        // 通过共享状态挂载，若加载页已收尾则不会再把回调装回 cc.loader
        daxiguaLoading.attachProgress(onProgress);

        if (splash) {
            splash.style.display = 'block';
        }
        // progressBar.style.width = '0%';

        cc.director.once(cc.Director.EVENT_AFTER_SCENE_LAUNCH, function() {
            // 场景真正启动：无论进度是否曾到过 100%，都由共享状态统一收尾
            daxiguaLoading.handleSceneLaunched();
        });
    }

    var onStart = function() {

        cc.loader.downloader._subpackages = settings.subpackages;

        cc.view.enableRetina(true);
        cc.view.resizeWithBrowserSize(true);

        if (!false && !false) {

            if (cc.sys.isBrowser) {
                setLoadingDisplay();
            }

            if (cc.sys.isMobile) {
                if (settings.orientation === 'landscape') {
                    cc.view.setOrientation(cc.macro.ORIENTATION_LANDSCAPE);
                } else if (settings.orientation === 'portrait') {
                    cc.view.setOrientation(cc.macro.ORIENTATION_PORTRAIT);
                }
                // cc.view.enableAutoFullScreen([
                //     cc.sys.BROWSER_TYPE_BAIDU,
                //     cc.sys.BROWSER_TYPE_WECHAT,
                //     cc.sys.BROWSER_TYPE_MOBILE_QQ,
                //     cc.sys.BROWSER_TYPE_MIUI,
                // ].indexOf(cc.sys.browserType) < 0);
                cc.view.enableAutoFullScreen(false);
            }

            // Limit downloading max concurrent task to 2,
            // more tasks simultaneously may cause performance draw back on some android system / browsers.
            // You can adjust the number based on your own test result, you have to set it before any loading process to take effect.
            if (cc.sys.isBrowser && cc.sys.os === cc.sys.OS_ANDROID) {
                cc.macro.DOWNLOAD_MAX_CONCURRENT = 2;
            }
        }

        // function loadScene(launchScene) {
        // cc.director.loadScene(launchScene, null,
        // function () {
        // if (cc.sys.isBrowser) {
        // // show canvas
        // var canvas = document.getElementById('GameCanvas');
        // canvas.style.visibility = '';
        // var div = document.getElementById('GameDiv');
        // if (div) {
        // div.style.backgroundImage = '';
        // }
        // }
        // cc.loader.onProgress = null;
        // console.log('Success to load scene: ' + launchScene);
        // }
        // );

        // }

        var launchScene = settings.launchScene;

        // load scene
        // loadScene(launchScene);

        var canvas;

        if (cc.sys.isBrowser) {
            canvas = document.getElementById('GameCanvas');
        }
        var launchScene = settings.launchScene;
        console.log("landscape,", launchScene);
        var MainManger = __require("MainManage");
        MainManger.init(launchScene, cc.sys.isBrowser, canvas.style.visibility);






    };

    // jsList
    var jsList = settings.jsList;

    if (false) {
        BK.Script.loadlib();
    } else {
        var bundledScript = settings.debug ? 'src/project.dev.js' : 'src/project.js';
        if (jsList) {
            jsList = jsList.map(function(x) {
                return 'src/' + x;
            });
            jsList.push(bundledScript);
        } else {
            jsList = [bundledScript];
        }
    }

    var option = {
        id: 'GameCanvas',
        scenes: settings.scenes,
        debugMode: settings.debug ? cc.debug.DebugMode.INFO : cc.debug.DebugMode.ERROR,
        showFPS: !false && settings.debug,
        frameRate: 60,
        jsList: jsList,
        groupList: settings.groupList,
        collisionMatrix: settings.collisionMatrix,
    }

    // init assets
    cc.AssetLibrary.init({
        libraryPath: 'res/import',
        rawAssetsBase: 'res/raw-',
        rawAssets: settings.rawAssets,
        packedAssets: settings.packedAssets,
        md5AssetsMap: settings.md5AssetsMap,
        subpackages: settings.subpackages
    });

    cc.game.run(option, onStart);
};

// main.js is qqplay and jsb platform entry file, so we must leave platform init code here
if (false) {
    BK.Script.loadlib('GameRes://src/settings.js');
    BK.Script.loadlib();
    BK.Script.loadlib('GameRes://libs/qqplay-downloader.js');

    var ORIENTATIONS = {
        'portrait': 1,
        'landscape left': 2,
        'landscape right': 3
    };
    BK.Director.screenMode = ORIENTATIONS[window._CCSettings.orientation];
    initAdapter();
    cc.game.once(cc.game.EVENT_ENGINE_INITED, function() {
        initRendererAdapter();
    });

    qqPlayDownloader.REMOTE_SERVER_ROOT = "";
    var prevPipe = cc.loader.md5Pipe || cc.loader.assetLoader;
    cc.loader.insertPipeAfter(prevPipe, qqPlayDownloader);

    window.boot();
} else if (window.jsb) {

    var isRuntime = (typeof loadRuntime === 'function');
    if (isRuntime) {
        require('src/settings.js');
        require('src/cocos2d-runtime.js');
        require('jsb-adapter/engine/index.js');
    } else {
        require('src/settings.js');
        require('src/cocos2d-jsb.js');
        require('jsb-adapter/jsb-engine.js');
    }

    cc.macro.CLEANUP_IMAGE_CACHE = true;
    window.boot();
}