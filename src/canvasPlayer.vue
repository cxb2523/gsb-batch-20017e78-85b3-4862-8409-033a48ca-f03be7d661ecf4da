<template>
  <div class="popup-layer">
    <div class="video-player-wrapper">
      <div id="VideoDom">
        <div id="canvasDom">
          <div v-show="showDom" id="progressBar" :class="[paused ? 'show' : '']">
            <div class="bar" @click="skipLine">
              <div
                ref="trunk"
                class="line"
                :class="['progress', paused ? 'pause' : 'play', !drag ? 'trans' : '']"
                :style="{ width: `${(playedTime / totalTime) * 100}%` }"
              ></div>
              <div id="circle" :class="{ trans: !drag }"></div>
            </div>

            <div class="left-box">
              <div href="#" class="btn">
                <button
                  class="play"
                  :class="[paused ? 'play' : 'pause']"
                  @click="changeVideoState"
                ></button>
              </div>
              <div class="total-time">{{ sToHs(playedTime) }} / {{ sToHs(totalTime) }}</div>
            </div>
            <div class="volume">
              <input type="checkbox" @click="changeVoiceStatus" />
              <svg viewBox="0 0 108 96">
                <path
                  d="M7,28 L35,28 L35,28 L59,8 L59,88 L35,68 L7,68 C4.790861,68 3,66.209139 3,64 L3,32 C3,29.790861 4.790861,28 7,28 Z"
                ></path>
                <path
                  d="M79,62 C83,57.3333333 85,52.6666667 85,48 C85,43.3333333 83,38.6666667 79,34 L49,3"
                ></path>
                <path
                  d="M95,69 C101.666667,61.6666667 105,54.3333333 105,47 C105,39.6666667 101.666667,32.3333333 95,25 L75.5,6 L49,33"
                ></path>
              </svg>
            </div>
          </div>
        </div>
      </div>
    </div>
    <i class="popup-layer-btn-close" @click="close">x</i>
    <div v-show="!showDom" class="loadEffect">
      <span></span>
      <span></span>
      <span></span>
      <span></span>
      <span></span>
      <span></span>
      <span></span>
      <span></span>
    </div>
    <section v-show="paused" class="playContainer" @click="changeVideoState">
      <li class="playBtn">
        <a href="#" title="start">Start</a>
      </li>
    </section>
  </div>
</template>

<script setup>
export default {
  data() {
    return {
      list: [],
      playerlist: [],
      // new add ===
      playIndex: 0,
      RAFCancelReq: null,
      logo: '',
      videoList: [],
      // 当前播放对象
      videoObj: {},
      // 是否暂停
      paused: true,
      // 总时长
      totalTime: 0,
      // 当前播放时长
      playedTime: 0,
      // 缓存进度条时间
      cacheCurrentTime: 0,
      endFlag: false,
      // 动态增减
      activeLength: 0,
      // 时间段节点记录,进度条快速定位
      skipDict: [],
      // 是否展示进度条
      showDom: false,
      // 是否已经绑定事件
      drag: 0,
    }
  },
  created() {
    // ==== 非响应式播放状态（DOM 对象不参与响应式）====
    // 当前正在播放的视频元素
    this.mainVideoObj = null
    // 仅用于预加载下一段的视频元素
    this.preloadVideoObj = null
    // 两个元素各自加载的源，用于判断能否复用
    this.mainUrl = ''
    this.preloadUrl = ''
    // 当前片段状态：{ url, start, end, baseTime, gen }
    this.segment = null
    // 片段代数：每次切换片段自增，旧片段的事件回调据此失效
    this.segmentGen = 0
    // 绘制循环代数：配合 RAFCancelReq 停掉上一段的绘制
    this.drawToken = 0
    // canvas 绘制上下文
    this.canvasCtx = null
    // 事件绑定标记（只绑一次，避免重复叠加）
    this.dropInited = false
    this.canvasClickBound = false
    // 当前片段是否已触发结束（防止 ontimeupdate 重复切下一段）
    this.segmentEnded = false
  },
  beforeDestroy() {
    this.releaseResources()
    if (typeof this.setFree === 'function') {
      this.setFree()
    }
  },
  mounted() {
    let _self = this
    this.init()
    _self.playerlist = _self.list.map((item) => {
      return {
        start: parseFloat(item.playPoint.start),
        end: parseFloat(item.playPoint.end),
      }
    })
    _self.videoList = _self.list
    _self.comTotalTime()
    document.addEventListener('keydown', _self.keydown)
    _self.$nextTick(() => {
      _self.initDrop2()
      _self.gotoPlay()
    })
  },

  methods: {
    initDrop2() {
      let _self = this
      if (_self.dropInited) {
        return
      }
      _self.dropInited = true
      _self.drag = 0
      let dropBtn = document.querySelector('#circle')
      //进度按钮被点击
      if (dropBtn) {
        dropBtn.addEventListener('mousedown', function() {
          _self.drag = 1
          if (_self.mainVideoObj && !_self.mainVideoObj.paused) {
            _self.mainVideoObj.pause()
            _self.stopDraw()
            _self.paused = true
          }
        })
      }
      //页面被释放
      document.addEventListener('mouseup', _self.mouseup)
      //拖动事件
      document.addEventListener('mousemove', _self.mouseover)
    },
    setValue(e) {
      let _self = this
      let progress = document.querySelector('.bar')
      if (!progress) {
        return
      }
      let rect = progress.getBoundingClientRect()
      let offset = e.clientX - rect.left
      //拖动边界检测
      if (offset < 0) {
        offset = 0
      } else if (offset > rect.width) {
        offset = rect.width
      }
      //拖动实时改变进度条
      _self.playedTime = (offset / rect.width) * _self.totalTime
    },
    mouseup() {
      let _self = this
      if (_self.drag === 1) {
        this.skipProgress()
      }
      this.drag = 0
    },
    mouseover(e) {
      let _self = this
      if (_self.drag === 1) {
        _self.setValue(e)
      }
    },
    // 快进跳转：按累计时间定位目标片段与片段内偏移
    skipProgress() {
      let _self = this
      let target = _self.playedTime
      if (target < 0) {
        target = 0
      } else if (target > _self.totalTime) {
        target = _self.totalTime
      }
      // skipDict 记录每段结束时的累计时长，找到第一段累计结束时间大于目标时间的片段
      let curIndex = _self.skipDict.findIndex((end) => target < end)
      if (curIndex === -1) {
        curIndex = _self.skipDict.length - 1
      }
      _self.endFlag = false
      _self.playIndex = curIndex
      // 片段内偏移 = 目标累计时间 - 之前所有片段的累计时长
      let baseTime = curIndex === 0 ? 0 : _self.skipDict[curIndex - 1]
      let shortSliceTime = target - baseTime
      _self.playedTime = target
      _self.VideoPlay(shortSliceTime)
    },
    // 点击快进跳转
    skipLine(e) {
      let _self = this
      let bar = e.currentTarget
      let rect = bar.getBoundingClientRect()
      let rate = ((e.clientX - rect.left) / rect.width) * _self.totalTime
      if (rate < 0) {
        rate = 0
      } else if (rate > _self.totalTime) {
        rate = _self.totalTime
      }
      _self.playedTime = rate
      _self.skipProgress()
    },
    init() {
      this.playedTime = 0
    },
    resetVideo() {
      if (this.mainVideoObj && !this.mainVideoObj.paused) {
        this.mainVideoObj.pause()
        this.paused = true
        this.playIndex = 0
      }
    },
    RAF(cb) {
      return window.requestAnimationFrame(() => {
        window.setTimeout(cb, 1000 / 60)
      })
    },
    // 计算总时长
    comTotalTime() {
      let _self = this
      let totalTime = 0
      _self.skipDict = []
      this.playerlist.map((item) => {
        let temp = item.end - item.start
        totalTime += temp
        _self.skipDict.push(totalTime)
      })
      this.totalTime = totalTime
    },
    close() {
      let _self = this
      try {
        if (typeof _self.onClose === 'function') {
          _self.onClose(_self)
        }
        _self.releaseResources()
        setTimeout(() => {
          _self.$destroy(true)
          if (_self.$el && _self.$el.parentNode) {
            _self.$el.parentNode.removeChild(_self.$el)
          }
        }, 200)
      } catch (e) {
        console.log(e)
      }
    },
    keydown(e) {
      let _self = this
      if (e.keyCode === 27) {
        // esc关闭消息
        _self.close()
      }
    },
    // add 播放器核心方法
    async gotoPlay() {
      let _self = this
      _self.playIndex = 0
      _self.paused = false
      _self.endFlag = false
      _self.VideoPlay(0)
    },
    // 截获当前视频播放器
    updateCurrentVideo(videoObj) {
      this.videoObj = videoObj
    },
    // 播放 || 暂停
    changeVideoState() {
      let _self = this
      let video = _self.videoObj
      if (!video || typeof video.play !== 'function') {
        return
      }
      if (_self.endFlag || video.paused) {
        if (_self.playIndex >= _self.playerlist.length) {
          _self.playedTime = 0
          _self.gotoPlay()
          return
        }
        video.play()
        _self.paused = false
      } else {
        video.pause()
        _self.stopDraw()
        _self.paused = true
      }
    },
    // 静音
    changeVoiceStatus() {
      if (this.videoObj && typeof this.videoObj.play === 'function') {
        this.videoObj.muted = !this.videoObj.muted
      }
    },
    // 核心启动逻辑：围绕 this.segment 这一份状态工作
    async VideoPlay(shortSliceTime = 0) {
      let _self = this
      if (_self.playIndex + 1 > _self.videoList.length) {
        return
      }
      // 一、先停掉上一段：绘制循环、事件回调（通过 segmentGen 失效）、播放
      _self.stopSegment()
      _self.segmentEnded = false

      // 二、解析当前片段参数，写入唯一的片段状态
      let currentVideo = _self.videoList[_self.playIndex]
      let currentUrl = currentVideo.url
      // 片段原始起点：进度换算与绘制边界的基准
      let currentStartTime = parseFloat(currentVideo.playPoint.start)
      // 初始定位点：跳转进入时落在片段中间
      let seekToTime = currentStartTime + (parseFloat(shortSliceTime) || 0)
      let currentEndTime = parseFloat(currentVideo.playPoint.end)
      // 之前所有片段的累计时长，进度条累计时间 = baseTime + 片段内偏移
      let baseTime = _self.playIndex === 0 ? 0 : _self.skipDict[_self.playIndex - 1]
      let gen = _self.segmentGen
      _self.segment = {
        url: currentUrl,
        start: currentStartTime,
        seekTo: seekToTime,
        end: currentEndTime,
        baseTime: baseTime,
        gen: gen,
      }
      // logo信息
      let currentLogoInfo = {
        logo: _self.logo,
        position: currentVideo.logoPosition,
        videoWidth: currentVideo.width,
      }

      // 三、准备 DOM：画布复用，视频元素主备互换复用
      let elDom = document.querySelector('#VideoDom')
      let canvasDom = document.querySelector('#canvasDom')
      let CanvasEle = _self.createCanvas(canvasDom, 'AutoCanvasId')
      _self.canvasCtx = CanvasEle.getContext('2d')
      if (!_self.canvasClickBound) {
        CanvasEle.addEventListener('click', _self.changeVideoState)
        _self.canvasClickBound = true
      }
      // 预加载元素命中目标源则直接提升为主播放元素，否则复用/新建主元素
      let videoObj = _self.acquireMainVideo(elDom, currentUrl)
      // 更新视频对象
      _self.updateCurrentVideo(videoObj)

      // 四、围绕当前片段状态绑定事件（旧片段回调已通过 segmentGen 失效）
      //视频meta加载完成后，定位到片段起点
      videoObj.onloadedmetadata = function() {
        if (gen !== _self.segmentGen) {
          return
        }
        _self.setVideoStyle(videoObj)
        videoObj.currentTime = seekToTime
        _self.cacheCurrentTime = seekToTime
      }
      //重新定位播放位置后开始播放
      videoObj.onseeked = function() {
        if (gen !== _self.segmentGen) {
          return
        }
        _self.paused = false
        videoObj.volume = 1
        let playPromise = videoObj.play()
        if (playPromise !== undefined) {
          playPromise.catch((error) => {
            console.log('sorry! 视频初始化失败', error)
          })
        }
      }
      //播放位置改变：进度条累计时间与实际播放位置保持一致
      videoObj.ontimeupdate = function() {
        if (gen !== _self.segmentGen || _self.segmentEnded) {
          return
        }
        let t = baseTime + (videoObj.currentTime - currentStartTime)
        _self.playedTime = Math.min(Math.max(t, 0), _self.totalTime)
        _self.cacheCurrentTime = videoObj.currentTime
        if (videoObj.currentTime >= currentEndTime) {
          _self.segmentEnded = true
          _self.playNext()
        }
      }
      //开始播放：尺寸对齐后启动本段的绘制循环
      videoObj.onplay = function() {
        if (gen !== _self.segmentGen) {
          return
        }
        CanvasEle.width = videoObj.width || videoObj.videoWidth
        CanvasEle.height = videoObj.height || videoObj.videoHeight
        _self.startDraw()
        // 创建logo
        _self.createAndPutLogo(canvasDom, 'logoId', currentLogoInfo)
        // 展示进度条
        _self.showDom = true
      }

      // 五、加载或定位到片段起点
      if (_self.mainUrl !== currentUrl) {
        videoObj.src = currentUrl
        _self.mainUrl = currentUrl
        videoObj.load()
      } else if (videoObj.readyState >= 1) {
        videoObj.currentTime = seekToTime
      }

      // 六、预加载下一段（复用同一个预加载元素，按需替换源）
      _self.setupPreload(elDom)
    },
    // 停止当前片段：使旧回调失效、停掉绘制循环、暂停播放
    stopSegment() {
      this.segmentGen++
      this.stopDraw()
      if (this.mainVideoObj && !this.mainVideoObj.paused) {
        this.mainVideoObj.pause()
      }
    },
    // 启动当前片段的绘制循环（先停掉旧循环，保证只有一段在绘制）
    startDraw() {
      let _self = this
      _self.stopDraw()
      let token = _self.drawToken
      let step = function() {
        if (token !== _self.drawToken) {
          return
        }
        _self.drawFrame()
        _self.RAFCancelReq = window.requestAnimationFrame(step)
      }
      _self.RAFCancelReq = window.requestAnimationFrame(step)
    },
    // 停止绘制循环
    stopDraw() {
      this.drawToken++
      if (this.RAFCancelReq) {
        window.cancelAnimationFrame(this.RAFCancelReq)
        this.RAFCancelReq = null
      }
    },
    // 绘制当前帧到画布
    drawFrame() {
      let _self = this
      let video = _self.mainVideoObj
      let seg = _self.segment
      if (!video || !seg || !_self.canvasCtx) {
        return
      }
      if (
        video.paused ||
        video.ended ||
        video.currentTime < seg.start ||
        video.currentTime >= seg.end
      ) {
        return
      }
      let canvas = _self.canvasCtx.canvas
      _self.canvasCtx.drawImage(video, 0, 0, canvas.width, canvas.height)
    },
    // 取主播放元素：预加载元素正是目标源则主备互换复用，否则复用/新建主元素
    acquireMainVideo(elDom, url) {
      let _self = this
      if (_self.preloadVideoObj && _self.preloadUrl === url) {
        let oldMain = _self.mainVideoObj
        let oldMainUrl = _self.mainUrl
        if (oldMain) {
          try {
            oldMain.pause()
          } catch (e) {/* 忽略：资源释放/预加载定位失败不影响主流程 */}
          _self.clearVideoHandlers(oldMain)
          oldMain.muted = true
        }
        let promoted = _self.preloadVideoObj
        promoted.muted = false
        _self.mainVideoObj = promoted
        _self.preloadVideoObj = oldMain
        _self.mainUrl = url
        _self.preloadUrl = oldMain ? oldMainUrl : ''
        return promoted
      }
      if (!_self.mainVideoObj) {
        _self.mainVideoObj = _self.createVideo(elDom, 'AutoVideoId')
        _self.mainUrl = ''
      }
      return _self.mainVideoObj
    },
    // 预加载下一段：只维护一个预加载对象，复用或替换而不是新增
    setupPreload(elDom) {
      let _self = this
      if (!_self.preloadVideoObj) {
        _self.preloadVideoObj = _self.createVideo(elDom, 'preLoadVideoId', true)
        _self.preloadUrl = ''
      }
      let preload = _self.preloadVideoObj
      _self.clearVideoHandlers(preload)
      let nextVideo = _self.videoList[_self.playIndex + 1]
      if (!nextVideo) {
        // 没有下一段：释放预加载元素占用的资源
        if (_self.preloadUrl) {
          preload.removeAttribute('src')
          preload.load()
          _self.preloadUrl = ''
        }
        return
      }
      let nextUrl = nextVideo.url
      let nextStart = parseFloat(nextVideo.playPoint.start)
      preload.muted = true
      if (_self.preloadUrl !== nextUrl) {
        preload.src = nextUrl
        _self.preloadUrl = nextUrl
        preload.load()
      }
      preload.onloadedmetadata = function() {
        try {
          preload.currentTime = nextStart
        } catch (e) {/* 忽略：资源释放/预加载定位失败不影响主流程 */}
      }
      if (preload.readyState >= 1) {
        try {
          preload.currentTime = nextStart
        } catch (e) {/* 忽略：资源释放/预加载定位失败不影响主流程 */}
      }
    },
    // 清掉视频元素上的事件回调
    clearVideoHandlers(video) {
      if (!video) {
        return
      }
      video.onloadedmetadata = null
      video.onseeked = null
      video.ontimeupdate = null
      video.onplay = null
      video.ondurationchange = null
    },
    // 释放全部资源：动画帧、视频元素、画布与 logo 节点、文档级事件
    releaseResources() {
      let _self = this
      // 取消未完成的动画帧，使所有片段回调失效
      _self.stopDraw()
      _self.segmentGen++
      // 移除文档级事件（与 initDrop2/mounted 中注册的引用一致）
      document.removeEventListener('keydown', _self.keydown)
      document.removeEventListener('mousemove', _self.mouseover)
      document.removeEventListener('mouseup', _self.mouseup)
      // 暂停并移除创建的视频节点
      ;['mainVideoObj', 'preloadVideoObj'].forEach((key) => {
        let video = _self[key]
        if (video) {
          try {
            video.pause()
          } catch (e) {/* 忽略：资源释放/预加载定位失败不影响主流程 */}
          _self.clearVideoHandlers(video)
          video.removeAttribute('src')
          try {
            video.load()
          } catch (e) {/* 忽略：资源释放/预加载定位失败不影响主流程 */}
          if (video.parentNode) {
            video.parentNode.removeChild(video)
          }
        }
        _self[key] = null
      })
      _self.mainUrl = ''
      _self.preloadUrl = ''
      _self.videoObj = null
      // 移除画布与 logo 节点
      ;['AutoCanvasId', 'logoId'].forEach((id) => {
        let node = document.getElementById(id)
        if (node && node.parentNode) {
          node.parentNode.removeChild(node)
        }
      })
      _self.canvasCtx = null
      _self.segment = null
    },
    // 创建并摆放logo
    createAndPutLogo(parentDom, domId, logoInfo) {
      this.$nextTick(() => {
        let canvasDom = document.querySelector('#AutoCanvasId')
        if (!canvasDom) {
          return
        }
        parentDom = parentDom || document.body
        let obj = document.getElementById(domId)
        if (!obj) {
          obj = document.createElement('img')
          obj.id = domId
          parentDom.appendChild(obj)
        }
        obj.style = {}
        obj.style.display = 'none'
        obj.style.width = `${(canvasDom.width * 150) / 1080}px`
        obj.style.position = 'absolute'
        obj.style[logoInfo.position.x] = `${(canvasDom.width / 1080) * 60}px`
        obj.style[logoInfo.position.y] = `${(canvasDom.width / 1080) * 60}px`
        obj.src = logoInfo.logo
        this.$nextTick(() => {
          obj.style.display = 'block'
        }, 10000)
      })
    },
    //根据父容器大小设置视频尺寸
    setVideoStyle(vObj) {
      let parentWidth = vObj.parentNode.getBoundingClientRect().width
      let parentHeight = vObj.parentNode.getBoundingClientRect().height
      //根据父容器宽高计算 视频缩放比例
      let scaleVal = Math.max(vObj.videoWidth / parentWidth, vObj.videoHeight / parentHeight)
      let scaleWidth = vObj.videoWidth / scaleVal
      let scaleHeight = vObj.videoHeight / scaleVal
      vObj.width = scaleWidth
      vObj.height = scaleHeight
    },

    //创建视频对象
    createVideo(parentDom, domId, isMuted = false) {
      if (!domId) {
        console.warn('缺少命名ID')
        return
      }
      parentDom = parentDom || document.body
      let obj = document.getElementById(domId)
      if (!obj) {
        obj = document.createElement('Video')
        obj.id = domId
        parentDom.appendChild(obj)
        //设置视频属性
        obj.preload = 'auto'
        obj.style = 'background:#000000;display:none;position:absolute;left:100%;top:0;'
        obj.muted = isMuted
        obj.volume = 0.1
      }
      return obj
    },
    //创建 Canvas对象
    createCanvas(parentDom, domId) {
      if (!domId) {
        console.warn('缺少命名ID')
        return
      }
      parentDom = parentDom || document.body
      let Obj = document.getElementById(domId)
      if (!Obj) {
        Obj = document.createElement('Canvas')
        Obj.id = domId
        parentDom.appendChild(Obj)
      }
      return Obj
    },

    // 播放下一段：先停上一段的绘制，再启动新片段
    playNext() {
      let _self = this
      _self.playIndex++
      if (_self.playIndex > _self.videoList.length - 1) {
        // 全部播完：停绘制、停播放，进度条停在末尾
        _self.stopSegment()
        _self.playedTime = _self.totalTime
        _self.paused = true
        _self.endFlag = true
        return
      }
      _self.VideoPlay(0)
    },
    sToHs(s) {
      //计算分钟
      //算法：将秒数除以60，然后下舍入，既得到分钟数
      s = parseFloat(s).toFixed(0)
      var h
      h = Math.floor(s / 60)
      //计算秒
      //算法：取得秒%60的余数，既得到秒数
      s = s % 60
      //将变量转换为字符串
      h += ''
      s += ''
      //如果只有一位数，前面增加一个0
      h = h.length == 1 ? '0' + h : h
      s = s.length == 1 ? '0' + s : s
      return h + ':' + s
    },
  },
}
</script>
<style>
@import './style/style.css';
</style>
<style lang="less" scoped>
.popup-layer {
  position: fixed;
  left: 0;
  top: 0;
  right: 0;
  bottom: 0;
  background-color: rgba(0, 0, 0, 0.85);
  color: #fff;

  .video-player-wrapper {
    position: absolute;
    left: 0;
    top: 0;
    right: 0;
    bottom: 0;
    display: flex;
    justify-content: center;
    align-items: center;
  }

  .popup-layer-btn-close {
    position: absolute;
    right: 20px;
    top: 20px;
    width: 50px;
    color: rgba(255, 255, 255, 0.8);
    text-align: center;
    font-style: initial;
    font-size: 40px;
    line-height: 30px;
    cursor: pointer;
    padding: 6px 0 12px;
    border-radius: 100%;
    user-select: none;
    &:hover {
      background: rgba(255, 255, 255, 0.05);
      color: rgba(255, 255, 255, 1);
    }
  }
}

#VideoDom {
  position: relative;
  font-size: 0;
  line-height: 0;
  width: 100%;
  height: 100%;
  display: flex;
  justify-content: center;
  align-items: center;
  #canvasDom {
    position: relative;
    #progressBar {
      position: absolute;
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      bottom: 0;
      width: 100%;
      background: rgba(0, 0, 0, 0.521);
      z-index: 99;
      opacity: 0;
      transition: all 0.5s;
      .left-box {
        display: flex;
        align-items: center;
        justify-content: flex-start;
        width: 50%;
        .btn {
          height: 100%;
          color: #000;
          margin-right: 2px;
          background: transparent;
          border: none;
          button {
            margin: 10px;
            padding: 0;
            box-sizing: border-box;
            border: transparent;
            background: transparent;
            user-select: none;
            &.play {
              height: 20px;
              border-style: solid;
              outline: none;
              border-width: 10px 0 10px 18px;
              border-color: transparent transparent transparent #00a1d6;
              transition: all 0.1s linear;
            }
            &.pause {
              border-style: double;
              border-width: 0px 0px 0px 18px;
              border-color: #00a1d6;
            }
          }
        }
        .total-time {
          color: #e3e3e3;
          font-size: 15px;
          line-height: 100%;
          pointer-events: none;
          user-select: none;
        }
      }

      .bar {
        display: flex;
        align-items: center;
        margin: 10px auto 0;
        width: 98%;
        height: 7px;
        border-radius: 10px;
        background: #7171716e;
        transition: all 0.2s;
        cursor: pointer;
        .line {
          position: relative;
          width: 100%;
          height: 100%;
          background: #00a1d6;
          border-radius: 5px;
          animation-timing-function: linear;
          &.trans {
            transition: all 0.5s;
          }
          &.play {
            animation-play-state: running;
          }
          &.pause {
            animation-play-state: paused;
          }
        }
        #circle {
          position: relative;
          margin-left: -4px;
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: #fff;
          pointer-events: none;
          &.trans {
            pointer-events: auto;
            transition: all 0.5s;
          }
        }
      }

      &:hover {
        .bar {
          height: 13px;
          transition: all 0.2s;
          #circle {
            height: 14px;
            width: 14px;
          }
        }
      }
      &.show {
        opacity: 1;
      }
    }
    &:hover {
      #progressBar {
        opacity: 1;
        transition: all 1s;
      }
    }
  }
}
</style>
