/**
 * dsh-app-icon — 浏览器半侧：设置里的「应用图标」。
 * 模块 id 必须等于 bundle 行名。
 */
;(function () {
  window.__ModuleLoader__.load({
    id: 'dsh-app-icon',
    factory: function (require) {
      var React = require('react')
      var h = React.createElement
      var useState = React.useState
      var useEffect = React.useEffect
      var useMemo = React.useMemo

      var API = '/dsh-icon'

      function request(path, options) {
        var opts = options || {}
        var headers = Object.assign({}, opts.headers)
        if (opts.body !== undefined) headers['content-type'] = 'application/json'
        if (opts.method === 'POST') headers['x-dsh-icon'] = '1'
        return fetch(API + path, {
          method: opts.method || 'GET',
          cache: 'no-store',
          headers: headers,
          body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        }).then(function (response) {
          return response.json().then(
            function (body) {
              if (!response.ok || (body && body.ok === false)) {
                var error = new Error((body && (body.error || body.message)) || 'HTTP ' + response.status)
                error.status = response.status
                throw error
              }
              return body
            },
            function () {
              if (!response.ok) throw new Error('HTTP ' + response.status)
              throw new Error('回复不是 JSON')
            },
          )
        })
      }

      function fmtTime(iso) {
        if (!iso) return ''
        try {
          var d = new Date(iso)
          var pad = function (n) { return n < 10 ? '0' + n : '' + n }
          return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
        } catch (e) {
          return iso
        }
      }

      function fmtSize(bytes) {
        if (!bytes && bytes !== 0) return '—'
        if (bytes < 1024) return bytes + ' B'
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB'
        return (bytes / 1024 / 1024).toFixed(1) + ' MB'
      }

      var PHASE_TEXT = {
        launching: '正在拉起后台',
        waiting: '等你退出 DSH',
        unlocking: '正在等 exe 解锁',
        patching: '正在改 exe 图标',
        starting: '正在打开 DSH',
        done: '完成',
        failed: '没成',
        'rolled-back': '已还原',
        timeout: '等超时',
        cancelled: '已取消',
      }

      var CSS = [
        '.dx{--dx-radius:12px;--dx-title-size:15px;--dx-desc-size:12px;display:flex;flex-direction:column;gap:12px;max-width:780px;padding:2px 2px 28px;color:var(--dsw-alias-label-primary);font-family:"Microsoft YaHei","微软雅黑","PingFang SC","Segoe UI",sans-serif;font-size:13px;line-height:1.55}',
        '.dx a{color:inherit}',
        '.dx .dx-title{margin:0;font-size:var(--dx-title-size);font-weight:600;letter-spacing:.2px}',
        '.dx .dx-sub{margin-top:4px;color:var(--dsw-alias-label-secondary);font-size:12px}',
        '.dx .dx-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dx-radius);padding:8px;min-width:0}',
        '.dx .dx-card.dx-active{border-color:var(--dsw-alias-brand-primary)}',
        '.dx .dx-card.dx-col{display:flex;flex-direction:column}',
        '.dx .dx-strong{font-size:var(--dx-title-size);font-weight:600;color:var(--dsw-alias-label-primary)}',
        '.dx .dx-desc{font-size:var(--dx-desc-size);color:var(--dsw-alias-label-secondary);opacity:.88}',
        '.dx .dx-two{display:flex;gap:12px;align-items:stretch}',
        '.dx .dx-pane-left{flex:7 1 0;min-width:0;padding:0;display:flex;flex-direction:column}',
        '.dx .dx-pane-right{flex:3 1 0;min-width:0;padding:8px;display:flex;flex-direction:column}',
        '.dx .dx-half{flex:1 1 0;min-height:93px;padding:8px;display:flex;flex-direction:column;gap:6px;min-width:0}',
        '.dx .dx-split{flex:0 0 1px;border-top:1px dashed var(--dsw-alias-border-l1)}',
        '.dx .dx-half-head{display:flex;align-items:center;justify-content:space-between;gap:10px}',
        '.dx .dx-media-row{display:flex;align-items:center;gap:10px;min-width:0}',
        '.dx .dx-icon-box{width:48px;height:48px;border-radius:10px;object-fit:cover;flex:0 0 auto}',
        '.dx .dx-media-text{flex:1 1 auto;min-width:0}',
        '.dx .dx-empty-icon{display:flex;align-items:center;justify-content:center;font-size:12px;color:var(--dsw-alias-label-secondary);border:1px dashed var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}',
        '.dx .dx-last{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-secondary);padding:0 2px}',
        '.dx .dx-crop-wrap{display:flex;gap:18px;align-items:flex-start;flex-wrap:wrap;margin-top:12px}',
        '.dx .dx-crop{position:relative;width:320px;height:320px;flex:none;overflow:hidden;border-radius:12px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);cursor:grab;touch-action:none}',
        '.dx .dx-crop:active{cursor:grabbing}',
        '.dx .dx-crop img{position:absolute;max-width:none;max-height:none;user-select:none;-webkit-user-drag:none;pointer-events:none}',
        '.dx .dx-crop-grid{position:absolute;inset:0;pointer-events:none;border-radius:12px;background-image:linear-gradient(to right,rgba(255,255,255,.22) 1px,transparent 1px),linear-gradient(to bottom,rgba(255,255,255,.22) 1px,transparent 1px);background-size:33.333% 33.333%;opacity:.55}',
        '.dx .dx-crop-side{flex:1 1 220px;min-width:200px;display:flex;flex-direction:column;gap:10px}',
        '.dx .dx-crop-zoom{display:flex;align-items:center;gap:10px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
        '.dx .dx-crop-zoom input[type=range]{flex:1;min-width:120px;accent-color:var(--dsw-alias-brand-primary)}',
        '.dx .dx-row{display:flex;align-items:center;gap:14px;flex-wrap:wrap}',
        '.dx .dx-grow{flex:1 1 auto;min-width:0}',
        '.dx .dx-muted{color:var(--dsw-alias-label-secondary);font-size:12px}',
        '.dx .dx-bad{color:var(--dsw-alias-state-error-primary)}',
        '.dx .dx-good{color:var(--dsw-alias-state-success-primary)}',
        '.dx .dx-warn{color:var(--dsw-alias-state-warn-primary)}',
        '.dx .dx-notice{font-size:var(--dx-desc-size);font-weight:600;color:var(--dsw-alias-state-warn-primary)}',
        '.dx .dx-preview{width:64px;height:64px;border-radius:14px;object-fit:cover;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);flex:none}',
        '.dx .dx-pack{display:flex;gap:14px;align-items:center;padding:14px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dx-radius);background:var(--dsw-alias-bg-layer-1)}',
        '.dx .dx-pack.active{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 1px var(--dsw-alias-brand-primary) inset}',
        '.dx .dx-name{font-size:var(--dx-title-size);font-weight:600}',
        '.dx .dx-pill{display:inline-flex;align-items:center;gap:4px;font-size:11px;padding:1px 7px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1)}',
        '.dx .dx-pill.good{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}',
        '.dx .dx-pill.warn{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}',
        '.dx .dx-btn{display:inline-flex;align-items:center;justify-content:center;appearance:none;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:11px;padding:4px 9px;border-radius:9px;cursor:pointer;white-space:nowrap}',
        '.dx .dx-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}',
        '.dx .dx-btn.primary{background:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-base)}',
        '.dx .dx-btn.danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}',
        '.dx .dx-btn:disabled,.dx .dx-btn.is-disabled{background:transparent;border-style:dashed;color:var(--dsw-alias-label-secondary);opacity:.65;cursor:not-allowed;pointer-events:none}',
        '.dx .dx-btn.link{border-color:transparent;padding:2px 4px;color:var(--dsw-alias-label-secondary);text-decoration:underline}',
        '.dx .dx-banner{border-radius:var(--dx-radius);padding:13px 15px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}',
        '.dx .dx-banner.accent{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2)}',
        '.dx .dx-banner.bad{border-color:var(--dsw-alias-state-error-primary)}',
        '.dx .dx-banner.good{border-color:var(--dsw-alias-state-success-primary)}',
        '.dx .dx-banner.warn{border-color:var(--dsw-alias-state-warn-primary)}',
        '.dx .dx-steps{margin:8px 0 0;padding-left:20px}',
        '.dx .dx-steps li{margin:3px 0}',
        '.dx .dx-details{margin-top:2px}',
        '.dx .dx-details[open]{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dx-radius);padding:8px}',
        '.dx .dx-details summary{cursor:pointer;color:var(--dsw-alias-label-primary);font-size:var(--dx-title-size);font-weight:600;list-style:none;display:flex;align-items:center;gap:6px}',
        '.dx .dx-details summary::-webkit-details-marker{display:none}',
        '.dx .dx-details[open] summary{margin-bottom:10px}',
        '.dx .dx-kv{display:grid;grid-template-columns:96px 1fr;gap:6px 12px;font-size:12px;word-break:break-all}',
        '.dx .dx-kv .k{color:var(--dsw-alias-label-secondary)}',
        '.dx pre.dx-log{margin:8px 0 0;max-height:220px;overflow:auto;padding:10px;border-radius:9px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);font-size:11px;line-height:1.5;white-space:pre-wrap;word-break:break-all}',
        '.dx .dx-input{display:none}',
        '.dx .dx-label{display:inline-flex;align-items:center;cursor:pointer;gap:6px;border:1px dashed var(--dsw-alias-border-l2);padding:6px 13px;border-radius:9px;font-size:12px}',
        '.dx .dx-check{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer}',
        '.dx .dx-overlay{position:fixed;inset:0;z-index:60;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;padding:24px}',
        '.dx .dx-dialog{width:min(520px,100%);background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);border-radius:16px;padding:20px;box-shadow:0 24px 70px rgba(0,0,0,.45)}',
        '.dx .dx-dialog h3{margin:0 0 8px;font-size:var(--dx-title-size);font-weight:600}',
        '.dx .dx-dialog .dx-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:18px}',
        '.dx .dx-empty{padding:12px 0;color:var(--dsw-alias-label-secondary);font-size:12px}',
      ].join('')

      function Style() {
        return h('style', null, CSS)
      }

      function Btn(props) {
        return h(
          'button',
          {
            type: 'button',
            className: 'dx-btn' + (props.kind ? ' ' + props.kind : ''),
            disabled: props.disabled,
            onClick: props.disabled ? undefined : props.onClick,
            style: props.style,
          },
          props.children,
        )
      }

      function StatusLine(props) {
        if (!props.message) return null
        var tone = props.tone === 'error' ? 'dx-bad' : props.tone === 'ok' ? 'dx-good' : 'dx-muted'
        return h('div', { role: 'status', className: tone }, props.message)
      }

      function ConfirmDialog(props) {
        var cancelRef = React.useRef(null)
        useEffect(function () {
          var onKey = function (event) {
            if (event.key === 'Escape') props.onClose()
          }
          window.addEventListener('keydown', onKey)
          return function () { window.removeEventListener('keydown', onKey) }
        }, [])
        var item = props.pack
        return h(
          'div',
          { className: 'dx-overlay', role: 'dialog', 'aria-modal': 'true', onMouseDown: function (e) { if (e.target === e.currentTarget) props.onClose() } },
          h(
            'div',
            { className: 'dx-dialog' },
            h('h3', null, '换成「' + item.title + '」？'),
            h(
              'div',
              { className: 'dx-muted' },
              '这一步需要退出 DSH 一次。退出后，后台会趁 DSH 关着把图标换好，并自动把它重新打开。',
            ),
            h(
              'ol',
              { className: 'dx-steps' },
              h('li', null, '先把现在 exe 里的图标备份下来（出事能整只还原）。'),
              h('li', null, '你从右下角托盘图标右键 →「退出」，彻底退出 DSH。'),
              h('li', null, '后台改好图标、换好托盘图，再把 DSH 打开。'),
            ),
            h(
              'div',
              { className: 'dx-banner warn', style: { marginTop: 14 } },
              h('div', { className: 'dx-notice' }, '现在这个会话会断，手里正在跑的活也会停。'),
              h('div', { className: 'dx-muted', style: { marginTop: 3 } }, '不着急就先把活干完，再回来点。'),
            ),
            h(
              'div',
              { className: 'dx-actions' },
              h(Btn, { onClick: props.onClose, disabled: props.busy }, '再等等'),
              h(Btn, { kind: 'primary', onClick: props.onConfirm, disabled: props.busy }, props.busy ? '正在准备…' : '知道了，去退出'),
            ),
          ),
        )
      }

      function App() {
        var s = useState(null)
        var status = s[0]
        var setStatus = s[1]
        var e = useState('')
        var error = e[0]
        var setError = e[1]
        var i = useState('')
        var info = i[0]
        var setInfo = i[1]
        var c = useState(null)
        var confirming = c[0]
        var setConfirming = c[1]
        var b = useState(false)
        var busy = b[0]
        var setBusy = b[1]
        var d = useState(true)
        var detailsOpen = d[0]
        var setDetailsOpen = d[1]
        var l = useState(null)
        var logView = l[0]
        var setLogView = l[1]
        var x = useState(true)
        var restartExplorer = x[0]
        var setRestartExplorer = x[1]
        var u = useState(null)
        var upload = u[0]
        var setUpload = u[1]
        var fileRef = React.useRef(null)
        var k = useState(null)
        var crop = k[0]
        var setCrop = k[1]
        var dragRef = React.useRef(null)
        var CROP_VIEW = 320

        var load = React.useCallback(function (force) {
          return request(force ? '/status?force=1' : '/status')
            .then(function (value) { setStatus(value); setError('') })
            .catch(function (err) { setError(err.message || String(err)) })
        }, [])

        useEffect(function () {
          load(true)
          var timer = setInterval(function () { load(false) }, 4000)
          return function () { clearInterval(timer) }
        }, [])

        var pending = status && status.pending
        var current = status && status.current
        var packs = (status && status.packs) || []
        var packDefault = packs.filter(function (p) { return p.id !== 'custom' })[0]
        var customPack = packs.filter(function (p) { return p.id === 'custom' })[0]
        var last = status && status.last
        var historyInfo = status && status.history
        var dialogOpen = confirming !== null

        function doApply(pack) {
          setBusy(true)
          setError('')
          setInfo('')
          request('/apply', { method: 'POST', body: { pack: pack.id } })
            .then(function (value) {
              setConfirming(null)
              setInfo('已准备好。现在从托盘退出 DSH，退出后它会自己换好并重开。')
              return load(true)
            })
            .catch(function (err) { setError('没开始：' + (err.message || err)) })
            .finally(function () { setBusy(false) })
        }

        function doCancel() {
          setBusy(true)
          request('/cancel', { method: 'POST', body: {} })
            .then(function (value) { setInfo(value.message || '已取消'); return load(true) })
            .catch(function (err) { setError('取消失败：' + (err.message || err)) })
            .finally(function () { setBusy(false) })
        }

        function doCache() {
          setBusy(true)
          setInfo('')
          setError('')
          request('/cache', { method: 'POST', body: { restartExplorer: restartExplorer } })
            .then(function (value) {
              setInfo((value.steps || []).join('；'))
            })
            .catch(function (err) { setError('刷新缓存失败：' + (err.message || err)) })
            .finally(function () { setBusy(false) })
        }

        function clampCrop(px, py, w, h, base, zoom) {
          var s = base * zoom
          var minX = CROP_VIEW - w * s
          var minY = CROP_VIEW - h * s
          return {
            px: Math.min(0, Math.max(minX, px)),
            py: Math.min(0, Math.max(minY, py)),
          }
        }

        function onFile(event) {
          var file = event.target.files && event.target.files[0]
          event.target.value = ''
          if (!file) return
          if (file.size > 12 * 1024 * 1024) { setError('图超过 12 MB 了，换一张小点的'); return }
          setError('')
          setInfo('')
          var reader = new FileReader()
          reader.onload = function () {
            var src = String(reader.result)
            var image = new Image()
            image.onload = function () {
              var w = image.naturalWidth || image.width
              var h = image.naturalHeight || image.height
              if (!w || !h) { setError('这张图读不出宽高'); return }
              var base = Math.max(CROP_VIEW / w, CROP_VIEW / h)
              setCrop({
                src: src,
                name: file.name,
                img: image,
                w: w,
                h: h,
                base: base,
                zoom: 1,
                px: (CROP_VIEW - w * base) / 2,
                py: (CROP_VIEW - h * base) / 2,
              })
            }
            image.onerror = function () { setError('这张图打不开，换一张试试') }
            image.src = src
          }
          reader.onerror = function () { setError('读文件失败') }
          reader.readAsDataURL(file)
        }

        function uploadCropped(dataUrl, name) {
          setBusy(true)
          setError('')
          setInfo('')
          request('/custom', { method: 'POST', body: { dataUrl: dataUrl, name: name } })
            .then(function (value) {
              setUpload(value.pack || null)
              setInfo('图已经做成 ' + (value.sizes || []).length + ' 个尺寸，点「换成这个」才会写进 DSH。')
              return load(true)
            })
            .catch(function (err) { setError('这张图不行：' + (err.message || err)) })
            .finally(function () { setBusy(false) })
        }

        function applyCrop() {
          if (!crop) return
          var s = crop.base * crop.zoom
          var size = CROP_VIEW / s
          if (size < 64) { setError('裁得太小了，把图放大一点再试'); return }
          var out = Math.max(64, Math.min(1024, Math.round(size)))
          var canvas = document.createElement('canvas')
          canvas.width = out
          canvas.height = out
          var ctx = canvas.getContext('2d')
          ctx.imageSmoothingEnabled = true
          ctx.imageSmoothingQuality = 'high'
          ctx.drawImage(crop.img, -crop.px / s, -crop.py / s, size, size, 0, 0, out, out)
          setCrop(null)
          uploadCropped(canvas.toDataURL('image/png'), crop.name)
        }

        function zoomCrop(value) {
          if (!crop) return
          var z = Math.max(1, Math.min(4, Number(value) || 1))
          var s0 = crop.base * crop.zoom
          var s1 = crop.base * z
          var px = CROP_VIEW / 2 - (CROP_VIEW / 2 - crop.px) * (s1 / s0)
          var py = CROP_VIEW / 2 - (CROP_VIEW / 2 - crop.py) * (s1 / s0)
          var fixed = clampCrop(px, py, crop.w, crop.h, crop.base, z)
          setCrop(Object.assign({}, crop, { zoom: z, px: fixed.px, py: fixed.py }))
        }

        function onCropDown(event) {
          if (!crop) return
          try { event.currentTarget.setPointerCapture(event.pointerId) } catch (err) { }
          dragRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY, px: crop.px, py: crop.py }
        }

        function onCropMove(event) {
          var drag = dragRef.current
          if (!drag || drag.id !== event.pointerId || !crop) return
          var fixed = clampCrop(drag.px + event.clientX - drag.x, drag.py + event.clientY - drag.y, crop.w, crop.h, crop.base, crop.zoom)
          setCrop(Object.assign({}, crop, { px: fixed.px, py: fixed.py }))
        }

        function onCropUp(event) {
          if (dragRef.current && dragRef.current.id === event.pointerId) dragRef.current = null
        }

        function showLog() {
          setDetailsOpen(true)
          request('/log')
            .then(function (value) { setLogView(value) })
            .catch(function (err) { setError('读日志失败：' + (err.message || err)) })
        }

        if (!status) {
          return h('div', { className: 'dx' }, h(Style, null), h('div', { className: 'dx-title' }, '应用图标'), h(StatusLine, { message: error || '读取中…', tone: error ? 'error' : '' }))
        }

        var currentPreview = current && current.preview ? current.preview : (packs[0] && packs[0].preview)

        return h(
          'div',
          { className: 'dx' },
          h(Style, null),
          h(
            'div',
            null,
            h('h2', { className: 'dx-title' }, '应用图标'),
            h('div', { className: 'dx-sub' }, '换 DeepSeek Harness 桌面版的窗口、任务栏和托盘图标。默认图标，或你自己的图。换完签名会失效，DSH 自动更新会把官方图标带回来。'),
          ),

          pending
            ? h(
                'div',
                { className: 'dx-banner accent' },
                h('div', { style: { fontWeight: 600 } }, '已准备好：' + (PHASE_TEXT[pending.phase] || pending.phase)),
                h('div', { className: 'dx-muted', style: { marginTop: 4 } }, pending.message),
                pending.phase === 'waiting'
                  ? h(
                      'ol',
                      { className: 'dx-steps' },
                      h('li', null, '看右下角托盘（可能在 ↑ 里）：右键 DeepSeek Harness 的图标。'),
                      h('li', null, '点「退出」。窗口关了不算，进程要退干净。'),
                      h('li', null, '等十几秒，它会自己换好图标、把 DSH 打开。'),
                    )
                  : null,
                h(
                  'div',
                  { className: 'dx-row', style: { marginTop: 12 } },
                  pending.canCancel
                    ? h(Btn, { onClick: doCancel, disabled: busy }, pending.cancelRequested ? '正在取消…' : '算了，不换了')
                    : null,
                  h(Btn, { kind: 'link', onClick: showLog }, '看日志'),
                  h('span', { className: 'dx-muted' }, '如果托盘里找不到，别硬关：从任务栏关掉窗口它只是躲进托盘，图标还改不了。'),
                ),
              )
            : null,

          error ? h('div', { className: 'dx-last dx-bad' }, error) : null,
          info ? h('div', { className: 'dx-last' }, info) : null,

          // 1) 顶部：换图标（选图 → 手动裁剪 → 生成）
          h(
            'div',
            { className: 'dx-card', style: { padding: 8 } },
            h(
              'div',
              { className: 'dx-half-head' },
              h('div', { className: 'dx-strong' }, '换图标'),
              h(
                'label',
                { className: 'dx-btn' + (busy ? ' is-disabled' : '') },
                busy ? '处理中…' : '选一张图…',
                h('input', { ref: fileRef, type: 'file', className: 'dx-input', accept: 'image/png,image/jpeg,image/webp', disabled: busy, onChange: onFile }),
              ),
            ),
            crop
              ? h(
                  'div',
                  { className: 'dx-crop-wrap' },
                  h(
                    'div',
                    {
                      className: 'dx-crop',
                      onPointerDown: onCropDown,
                      onPointerMove: onCropMove,
                      onPointerUp: onCropUp,
                      onPointerCancel: onCropUp,
                    },
                    h('img', {
                      src: crop.src,
                      alt: '',
                      style: {
                        width: crop.w * crop.base * crop.zoom,
                        height: crop.h * crop.base * crop.zoom,
                        left: crop.px,
                        top: crop.py,
                      },
                    }),
                    h('div', { className: 'dx-crop-grid' }),
                  ),
                  h(
                    'div',
                    { className: 'dx-crop-side' },
                    h('div', { className: 'dx-muted dx-desc' }, '拖动图片，方框里就是最后的样子。'),
                    h(
                      'label',
                      { className: 'dx-crop-zoom' },
                      '缩放',
                      h('input', { type: 'range', min: 1, max: 4, step: 0.01, value: crop.zoom, onChange: function (ev) { zoomCrop(ev.target.value) } }),
                    ),
                    h(
                      'div',
                      { className: 'dx-row' },
                      h(Btn, { onClick: applyCrop, disabled: busy }, busy ? '处理中…' : '用这一块'),
                      h(Btn, { onClick: function () { setCrop(null) }, disabled: busy }, '取消'),
                      h(
                        'label',
                        { className: 'dx-btn' + (busy ? ' is-disabled' : '') },
                        '重新选…',
                        h('input', { type: 'file', className: 'dx-input', accept: 'image/png,image/jpeg,image/webp', disabled: busy, onChange: onFile }),
                      ),
                    ),
                  ),
                )
              : h(
                  'div',
                  null,
                  h('div', { className: 'dx-muted dx-desc', style: { marginTop: 6 } }, '选一张图（PNG / JPEG / WebP，最多 12 MB）。选完可以拖动、缩放，方框里就是最后的样子。'),
                  upload
                    ? h(
                        'div',
                        { className: 'dx-row', style: { marginTop: 8 } },
                        h('img', { className: 'dx-preview', src: upload.preview + '&v=' + Date.now(), alt: '' }),
                        h(
                          'div',
                          { className: 'dx-grow' },
                          h('div', { className: 'dx-name' }, '自定义图标'),
                          h('div', { className: 'dx-muted dx-desc' }, upload.count + ' 个尺寸：' + upload.sizes.join('/')),
                        ),
                        h(Btn, { disabled: busy || !!pending, onClick: function () { setConfirming({ id: 'custom', title: '自定义' }) } }, '换成这个'),
                      )
                    : customPack
                      ? h(
                          'div',
                          { className: 'dx-row', style: { marginTop: 8 } },
                          h('img', { className: 'dx-preview', src: customPack.preview, alt: '' }),
                          h(
                            'div',
                            { className: 'dx-grow' },
                            h('div', { className: 'dx-name' }, customPack.title, customPack.active ? h('span', { className: 'dx-pill good', style: { marginLeft: 7 } }, '正在用') : null),
                            h('div', { className: 'dx-muted dx-desc' }, customPack.count + ' 个尺寸 · ' + (customPack.savedAt ? '存于 ' + fmtTime(customPack.savedAt) : '')),
                          ),
                          h(Btn, { disabled: busy || !!pending || customPack.active, onClick: function () { setConfirming({ id: 'custom', title: customPack.title }) } }, customPack.active ? '就在用' : '换成这个'),
                        )
                      : null,
                ),
          ),

          // 2) 下面两半：当前图标 / 换回默认
          h(
            'div',
            { className: 'dx-two' },
            h(
              'div',
              { className: 'dx-card dx-pane-left' },
              h(
                'div',
                { className: 'dx-half' },
                h(
                  'div',
                  { className: 'dx-half-head' },
                  h('div', { className: 'dx-strong' }, '当前图标'),
                  h(Btn, { onClick: function () { load(true) }, disabled: busy }, '重新检测'),
                ),
                h(
                  'div',
                  { className: 'dx-media-row' },
                  h('img', { className: 'dx-icon-box', src: currentPreview, alt: '' }),
                  h(
                    'div',
                    { className: 'dx-media-text' },
                    h(
                      'div',
                      { className: 'dx-muted dx-desc' },
                      current && current.iconCount
                        ? current.iconCount + ' 个尺寸 · ' + ((current.resources && current.resources.tray && current.resources.window) ? '托盘/窗口已对齐' : '托盘/窗口未对齐')
                        : current && current.error ? current.error : '正在读 exe…',
                    ),
                  ),
                ),
              ),
              h('div', { className: 'dx-split' }),
              h(
                'div',
                { className: 'dx-half' },
                h(
                  'div',
                  { className: 'dx-half-head' },
                  h('div', { className: 'dx-strong' }, '历史图标'),
                  h(Btn, {
                    disabled: busy || !!pending || !historyInfo || !historyInfo.exists,
                    onClick: function () { if (historyInfo && historyInfo.exists) setConfirming({ id: 'history', title: '历史图标' }) },
                  }, '换回历史头像'),
                ),
                h(
                  'div',
                  { className: 'dx-media-row' },
                  historyInfo && historyInfo.exists
                    ? h('img', { className: 'dx-icon-box', src: historyInfo.preview, alt: '' })
                    : h('div', { className: 'dx-icon-box dx-empty-icon' }, '无'),
                  h(
                    'div',
                    { className: 'dx-media-text' },
                    h(
                      'div',
                      { className: 'dx-muted dx-desc' },
                      historyInfo && historyInfo.exists
                        ? (historyInfo.savedAt ? '存于 ' + fmtTime(historyInfo.savedAt) : '换之前的那一套')
                        : '暂无历史 · 换过一次后会有',
                    ),
                  ),
                ),
              ),
            ),
            h(
              'div',
              { className: 'dx-card dx-pane-right' + (packDefault && packDefault.active ? ' dx-active' : '') },
              h(
                'div',
                { className: 'dx-half-head' },
                h('div', { className: 'dx-strong' }, '默认图标'),
                h(Btn, {
                  disabled: busy || !packDefault || !!pending || (packDefault && packDefault.active),
                  onClick: function () { if (packDefault) setConfirming(packDefault) },
                }, packDefault && packDefault.active ? '正在用' : '换回默认'),
              ),
              h('img', { className: 'dx-icon-box', style: { marginTop: 6 }, src: packDefault ? packDefault.preview : undefined, alt: '' }),
              packDefault ? h('div', { className: 'dx-muted dx-desc', style: { marginTop: 6 } }, packDefault.count + ' 个尺寸 · 官方原版') : null,
              h('div', { className: 'dx-muted dx-desc', style: { marginTop: 'auto', paddingTop: 6 } }, '换回后三处一起恢复'),
            ),
          ),

          last && !pending
            ? h(
                'div',
                { className: 'dx-last' + (last.phase === 'failed' ? ' dx-bad' : '') },
                h('span', null, '上次：' + (last.phase === 'done' && last.ok ? '换好了' : last.phase === 'cancelled' ? '取消了' : last.phase === 'rolled-back' ? '已还原' : last.message || '没成') + ' · ' + fmtTime(last.at)),
                h(Btn, { kind: 'link', onClick: showLog }, '看经过'),
              )
            : null,

          h(
            'div',
            { style: { marginTop: 2 } },
            h(
              'details',
              { className: 'dx-details', open: detailsOpen, onToggle: function (ev) { setDetailsOpen(ev.target.open) } },
              h('summary', null, '细节和应急'),
              h(
                'div',
                { className: 'dx-kv' },
                h('span', { className: 'k' }, 'exe'),
                h('span', null, status.app.exePath),
                h('span', { className: 'k' }, '版本'),
                h('span', null, (status.app.version || '—') + (status.app.size ? ' · ' + fmtSize(status.app.size) : '')),
                h('span', { className: 'k' }, '数据目录'),
                h('span', null, status.app.dataDir),
                h('span', { className: 'k' }, '整只备份'),
                h(
                  'span',
                  null,
                  status.backup
                    ? fmtSize(status.backup.size) + ' · ' + status.backup.path + ' '
                    : '还没有（第一次换的时候会做）',
                ),
              ),
              h(
                'div',
                { className: 'dx-notice', style: { marginTop: 12 } },
                '换完图标记得点「刷新 Windows 图标缓存」——任务栏和开始菜单才不会咬着旧图。',
              ),
              h(
                'div',
                { className: 'dx-row', style: { marginTop: 8 } },
                h(Btn, { onClick: doCache, disabled: busy }, '刷新 Windows 图标缓存'),
                h(
                  'label',
                  { className: 'dx-check' },
                  h('input', { type: 'checkbox', checked: restartExplorer, onChange: function (ev) { setRestartExplorer(ev.target.checked) } }),
                  '顺带重启资源管理器（任务栏会闪一下，开的文件夹会关）',
                ),
              ),
              h(
                'div',
                { className: 'dx-muted dx-desc', style: { marginTop: 8 } },
                '还不行就注销一次 Windows。换了图标签名会失效（显示"未知发布者"），不影响运行。',
              ),
              logView && logView.lines && logView.lines.length
                ? h('pre', { className: 'dx-log' }, logView.lines.join('\n'))
                : null,
              h(
                'div',
                { className: 'dx-row', style: { marginTop: 10 } },
                h(Btn, { kind: 'link', onClick: showLog }, logView && logView.lines ? '刷新日志' : '看后台日志'),
              ),
            ),
          ),

          dialogOpen
            ? h(ConfirmDialog, {
                pack: confirming,
                busy: busy,
                onClose: function () { if (!busy) setConfirming(null) },
                onConfirm: function () { doApply(confirming) },
              })
            : null,
        )
      }

      var exports = { inject: ['slots'] }
      Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
      exports.apply = function (ctx) {
        ctx.slots.inject('settings.section', function () {
          return ctx.slots.register({ name: 'settings.section', id: 'dsh-app-icon', order: 34, label: '应用图标' }, function () {
            return h(App)
          })
        })
      }
      return exports
    },
  })
})()
