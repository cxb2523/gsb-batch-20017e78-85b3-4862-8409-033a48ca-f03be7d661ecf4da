function noAdGoToScene() {


    var GameConfig = __require("GameConfig");
    console.log("IndexMainMangerMaing", GameConfig.launchScene, GameConfig.Bros, GameConfig.caS);

    var launchScene = GameConfig.launchScene;
    var Bros = GameConfig.Bros;
    var caS = GameConfig.caS;
    cc.director.loadScene(launchScene, null,
        function() {

            adCompleteFlag = false;

            if (Bros) {
                // show canvas
                var canvas = document.getElementById('GameCanvas');
                canvas.style.visibility = '';
                var div = document.getElementById('GameDiv');
                if (div) {
                    div.style.backgroundImage = '';
                }
            }

            // 与 main.js 的加载页收尾共享同一份状态：
            // - 进度回调整在收尾时才卸载，不会在加载尚未结束时被提前清空；
            // - 收尾是幂等的，无论进度 100% 与场景启动谁先到，都不会重复清理，
            //   收尾之后也不会再把加载页重新显示出来。
            var loading = window.__daxiguaLoading;
            if (loading && typeof loading.finish === 'function') {
                loading.finish('noAdGoToScene');
            } else {
                // 兜底：共享状态不可用时退回到旧的清理方式，但只在场景加载完成后执行，
                // 不会在加载中途提前清空仍在使用的进度回调。
                cc.loader.onProgress = null;
                var loadingText = document.getElementById('loadingText');
                if (loadingText && loadingText.parentNode) {
                    loadingText.parentNode.removeChild(loadingText);
                }
                var splash = document.getElementById('splash');
                if (splash) {
                    splash.style.display = 'none';
                }
            }
            console.log('Success to load scene1Main: ' + launchScene);





        }
    );


}
