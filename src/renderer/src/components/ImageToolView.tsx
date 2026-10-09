import clsx from 'clsx'
import { ArrowRight, CircleAlert, CircleCheck, Eye, FolderOpen, ImagePlus, Plus, RefreshCw, RotateCcw, RotateCw, SlidersHorizontal, Trash2, Upload, X } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { format as formatSpec } from '@shared/imageFormats'
import type { DetectedRegion, Destination, ImageFileInfo, ImageRunResult } from '@shared/imageOps'
import { BlurStage } from '../tools/BlurStage'
import { formatBytes } from '../i18n'
import { handOverTo, isImageTool, openPicture, openTool, takeHandOver, toast, useStore, useT, type ImageToolId, type ToolId } from '../store'
import { CompareStage, MethodLine, num, ResultFacts, ResultStrip, ResultThumb, ToolSwitcher, useBackLabel } from './ImageResults'
import { toolEntry } from '../tools/catalogue'
import { animateOptions, CropStage, defaultOptions, ImageOptions, InfoPanel, jobFor, outputNote, previewLine, type ImgOptions } from '../tools/ImageOptions'
import { Button, Select, Spinner } from './ui'
import { MarksStage, newTextLayer, widthForHeight, type MarkLayer } from '../tools/MarkLayers'
import { memeBands } from '../tools/ImageOptions'

/**
 * Every image tool's screen (decisions §69), as iLoveIMG lays its tools out: pictures as cards
 * (any format — the worker draws the previews, so HEIC, RAW and PSD show too), added with the +
 * card, the button or by dropping files; turned, removed and put in order on the card; the
 * tool's options in a panel beside them with the one action button at its foot; then a result
 * screen (§77) with the output large, before / after, what changed and how it was made, the options
 * still editable for "Try again" (which replaces this session's results), and "Continue with".
 * The title is a menu of the other image tools, which keep the pictures.
 */

export interface Card {
  key: string
  path: string
  name: string
  info: ImageFileInfo | null
  /** The picture could not be read: why. */
  failed?: string
  /** Rotate tool: this card's own turn, degrees clockwise. */
  rotate: number
  status: 'idle' | 'working' | 'done' | 'failed'
  result?: ImageRunResult
  results?: ImageRunResult[]
  error?: string
  /** Blur faces: the areas to hide (found, and drawn by hand), and whether the search runs. */
  regions?: DetectedRegion[]
  detecting?: boolean
}

let counter = 0

const percent = (language: string, n: number): string => (language === 'ar' ? `${num(language, n)}٪` : `${n}%`)
/** A meme caption: Impact, white with a black outline, across most of the width. */
const memeCaption = (text: string, y: number): Promise<MarkLayer> => newTextLayer(text, { font: 'Impact', bold: false, colour: '#ffffff', outline: '#000000', shadow: false, width: 0.8, y, opacity: 1 })

/** Each tool's last settings, kept while the app runs (remembering settings is a roadmap UX item). */
const remembered = new Map<ImageToolId, ImgOptions>()
let rememberedFolder: string | null = null

export function ImageToolView({ tool }: { tool: ImageToolId }) {
  const t = useT()
  const language = useStore((s) => s.settings?.language ?? 'en')
  const [cards, setCards] = useState<Card[]>([])
  const [opts, setOptsState] = useState<ImgOptions>(() => remembered.get(tool) ?? defaultOptions(tool))
  const [folder, setFolder] = useState<string | null>(rememberedFolder)
  const [phase, setPhase] = useState<'board' | 'running' | 'done'>('board')
  const [selected, setSelected] = useState<string | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const [dropAt, setDropAt] = useState<number | null>(null)
  const [layerSel, setLayerSel] = useState<string | null>(null)
  /** The settings the shown results were made with ("Try again" is offered once they change). */
  const [ranWith, setRanWith] = useState<string | null>(null)
  /** Pictures finished in the current run, and when the current picture started (time left). */
  const [finished, setFinished] = useState(0)
  const [cardStarted, setCardStarted] = useState(0)
  const stop = useRef(false)
  const backLabel = useBackLabel()
  const setOpts = (patch: Partial<ImgOptions>): void =>
    setOptsState((now) => {
      const next = { ...now, ...patch }
      remembered.set(tool, next)
      return next
    })

  const setLayers = (next: MarkLayer[] | ((now: MarkLayer[]) => MarkLayer[])): void =>
    setOptsState((now) => {
      const layers = typeof next === 'function' ? next(now.layers) : next
      const merged = { ...now, layers }
      remembered.set(tool, merged)
      return merged
    })
  const marksTool = tool === 'imgWatermark' || tool === 'imgMeme'
  const stageTool = tool === 'imgCrop' || marksTool || tool === 'imgBlur'
  const progress = useStore((s) => (s.progress?.task === 'image' ? s.progress.fraction : null))

  // A meme starts with its two captions, top and bottom, as every meme maker does.
  useEffect(() => {
    if (tool !== 'imgMeme' || opts.layers.length) return
    void Promise.all([memeCaption(t('meme.top'), 0.12), memeCaption(t('meme.bottom'), 0.88)]).then((captions) => setLayers((now) => (now.length ? now : captions)))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Meme captions are sized by their letters' height on the picture (inside), or to fit the bands.
  const memeRatio = tool === 'imgMeme' ? (cards.find((c) => c.key === selected)?.info ?? cards.find((c) => c.info)?.info ?? null) : null
  const ratio = memeRatio ? memeRatio.height / memeRatio.width : null
  useEffect(() => {
    if (tool !== 'imgMeme' || !ratio) return
    setLayers((now) => now.map((l, i) => (i > 1 || l.kind !== 'text' ? l : { ...l, width: widthForHeight(l, ratio, opts.memeOutside ? 0.15 : 0.13) })))
  }, [ratio, opts.memeOutside]) // eslint-disable-line react-hooks/exhaustive-deps

  // Blur faces: each picture is searched once it is read, one at a time; a change of what to look
  // for searches again (areas drawn by hand stay).
  const detectKey = `${opts.findFaces}-${opts.findPlates}-${opts.sensitivity}`
  const lastKey = useRef(detectKey)
  useEffect(() => {
    if (tool !== 'imgBlur') return
    if (lastKey.current !== detectKey) {
      lastKey.current = detectKey
      setCards((now) => now.map((c) => (c.regions ? { ...c, regions: undefined } : c)))
      return
    }
    const next = cards.find((c) => c.info && !c.failed && !c.regions && !c.detecting)
    if (!next || cards.some((c) => c.detecting)) return
    setCards((now) => now.map((c) => (c.key === next.key ? { ...c, detecting: true } : c)))
    void window.api.imageDetect(next.path, { faces: opts.findFaces, plates: opts.findPlates, sensitivity: opts.sensitivity }).then((r) => {
      setCards((now) =>
        now.map((c) => (c.key !== next.key ? c : { ...c, detecting: false, regions: [...(r.ok ? r.value : []), ...(c.regions ?? []).filter((x) => x.kind === 'manual')] }))
      )
    })
  }, [cards, detectKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const add = (paths: string[]): void => {
    const fresh = paths.map((path): Card => ({ key: `c${counter++}`, path, name: path.split(/[\\/]/).pop() ?? path, info: null, rotate: 0, status: 'idle' }))
    if (!fresh.length) return
    setCards((now) => [...now, ...fresh])
    setSelected((s) => s ?? fresh[0]!.key)
    setPhase('board')
    // Three at a time: a folder of RAW photos should not start fifty decodes at once.
    let next = 0
    const work = async (): Promise<void> => {
      while (next < fresh.length) {
        const card = fresh[next++]!
        const r = await window.api.imageDescribe(card.path)
        setCards((now) => now.map((x) => (x.key !== card.key ? x : r.ok ? { ...x, info: r.value } : { ...x, failed: r.error.message })))
      }
    }
    void Promise.all([work(), work(), work()])
  }
  const pick = async (): Promise<void> => add(await window.api.pickAnyImages())

  useEffect(() => {
    // Pictures handed over by "Continue with another tool" or the picture viewer (store.handOverTo).
    const given = takeHandOver()
    if (given.length) add(given)
    const onAdd = (e: Event): void => add((e as CustomEvent<string[]>).detail)
    window.addEventListener('powerpdf:imgtool-add', onAdd)
    return () => window.removeEventListener('powerpdf:imgtool-add', onAdd)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const usable = cards.filter((c) => c.info && !c.failed)
  const noMarks = (tool === 'imgWatermark' || tool === 'imgMeme') && opts.layers.length === 0
  const selectedCard = cards.find((c) => c.key === selected) ?? usable[0] ?? null
  const move = (from: number, to: number): void =>
    setCards((now) => {
      const next = [...now]
      const [x] = next.splice(from, 1)
      next.splice(to > from ? to - 1 : to, 0, x!)
      return next
    })
  const sort = (how: string): void =>
    setCards((now) => {
      const next = [...now].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
      return how === 'za' ? next.reverse() : next
    })
  const turnCard = (key: string, by: number): void => setCards((now) => now.map((c) => (c.key === key ? { ...c, rotate: (((c.rotate + by) % 360) + 360) % 360 } : c)))

  const destination = (): Destination => ({ folder, suffix: t(`img.suffix.${tool}`) })
  const minimum = tool === 'imgGif' ? 2 : 1

  /** What the results were made with: options and folder. */
  const settingsKey = JSON.stringify({ opts, folder })
  /** This session's results, which a new run replaces (decisions §77). Frames go to a new folder each time. */
  const replaceable = tool !== 'imgFrames'

  const run = async (): Promise<void> => {
    if (usable.length < minimum) return
    if (cards.some((c) => c.failed)) toast('info', t('img.skipped'))
    stop.current = false
    setPhase('running')
    setFinished(0)
    setCardStarted(Date.now())
    // Earlier results stay on the cards until each is replaced (a stopped run keeps the rest).
    setCards((now) => now.map((c) => (c.status === 'failed' ? { ...c, status: 'idle', error: undefined } : c)))
    if (tool === 'imgGif') {
      setCards((now) => now.map((c) => (c.info && !c.failed ? { ...c, status: 'working' } : c)))
      const previous = usable.find((c) => c.result)?.result?.path ?? null
      const r = await window.api.imageAnimate(
        usable.map((c) => c.path),
        animateOptions(opts, usable),
        { folder, suffix: '' },
        t('img.animationName'),
        previous
      )
      setCards((now) => now.map((c) => (c.info && !c.failed ? (r.ok ? { ...c, status: 'done', result: r.value } : { ...c, status: 'failed', error: r.error.message }) : c)))
      if (!r.ok) toast('error', r.error.message)
      setRanWith(settingsKey)
      setPhase('done')
      return
    }
    for (const [i, card] of usable.entries()) {
      if (stop.current) break
      setCards((now) => now.map((c) => (c.key === card.key ? { ...c, status: 'working' } : c)))
      setCardStarted(Date.now())
      if (tool === 'imgFrames') {
        const r = await window.api.imageFrames(card.path, destination())
        setCards((now) => now.map((c) => (c.key !== card.key ? c : r.ok ? { ...c, status: 'done', results: r.value, result: r.value[0] } : { ...c, status: 'failed', error: r.error.message })))
        setFinished(i + 1)
        continue
      }
      const previous = replaceable ? (card.result?.path ?? null) : null
      const r = await window.api.imageRun(card.path, jobFor(tool, opts, card), destination(), previous)
      // A failed try keeps the earlier result on the card (its file is still there).
      setCards((now) => now.map((c) => (c.key !== card.key ? c : r.ok ? { ...c, status: 'done', result: r.value, error: undefined } : { ...c, status: 'failed', error: r.error.message })))
      setFinished(i + 1)
    }
    setRanWith(settingsKey)
    setPhase('done')
  }

  const { icon: Icon } = toolEntry(tool)
  const CARD = 168
  const hasResults = cards.some((c) => c.result)
  const originals = usable.map((c) => c.path)
  const uniqueResults = [...new Set(cards.flatMap((c) => (c.status === 'done' ? (c.results ?? (c.result ? [c.result] : [])) : [])).map((r) => r.path))]

  /** The tool's options and where to save: on the board, and on the result screen for "Try again". */
  const optionsBody = (): ReactNode => (
    <>
      {tool === 'imgInfo' ? <InfoPanel card={selectedCard} /> : <ImageOptions tool={tool} opts={opts} setOpts={setOpts} cards={cards} setCards={setCards} selected={selectedCard} layerSel={layerSel} setLayerSel={setLayerSel} setLayers={setLayers} />}
      {tool !== 'imgInfo' || selectedCard ? (
        <section className="flex flex-col gap-2">
          <h3 className="text-[11px] font-semibold tracking-wider text-muted uppercase">{t('img.saveTo')}</h3>
          <div className="flex flex-col gap-1.5">
            <FolderChoice
              active={folder === null}
              label={t('img.sameFolder')}
              hint={t('img.sameFolderHint')}
              onClick={() => {
                setFolder(null)
                rememberedFolder = null
              }}
            />
            <FolderChoice
              active={folder !== null}
              label={folder ? (folder.split(/[\\/]/).pop() ?? folder) : t('img.chooseFolder')}
              hint={folder ?? t('img.chooseFolderHint')}
              onClick={async () => {
                const f = await window.api.pickFolder()
                if (f) {
                  setFolder(f)
                  rememberedFolder = f
                }
              }}
            />
          </div>
        </section>
      ) : null}
      {outputNote(tool, opts, t) && <p className="text-[11px] leading-relaxed text-faint">{outputNote(tool, opts, t)}</p>}
    </>
  )

  const header = (
    <header className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-5 py-2">
      <ToolSwitcher tool={tool} originals={originals} results={phase === 'done' ? uniqueResults : []} disabled={phase === 'running'} />
      <Button icon={<ImagePlus size={15} />} onClick={() => void pick()} disabled={phase === 'running'}>
        {t('addPictures')}
      </Button>
      {cards.length > 1 && phase === 'board' && (
        <div className="w-40">
          <Select
            value=""
            label={t('images.sort')}
            onChange={(v) => v && sort(v)}
            options={[
              { value: '', label: t('images.sort') },
              { value: 'az', label: t('images.sortAz') },
              { value: 'za', label: t('images.sortZa') }
            ]}
          />
        </div>
      )}
      <span className="flex-1" />
      {cards.length > 1 && <span className="text-[12px] text-muted">{t('images.count', { count: cards.length })}</span>}
      <Button icon={<X size={15} />} onClick={() => openTool(null)} disabled={phase === 'running'} title={backLabel} data-tool-close="">
        {t('close')}
      </Button>
    </header>
  )

  if (phase === 'done')
    return (
      <div className="flex h-full min-h-0 flex-col" data-image-tool={tool}>
        {header}
        <ResultView
          tool={tool}
          cards={cards}
          options={stageTool || tool === 'imgInfo' || tool === 'imgFrames' ? null : optionsBody()}
          changed={ranWith !== settingsKey}
          canRun={usable.length >= minimum && !noMarks}
          onTryAgain={() => void run()}
          onBack={() => setPhase('board')}
          onRestart={() => {
            setCards([])
            setRanWith(null)
            setPhase('board')
          }}
        />
      </div>
    )

  return (
    <div className="flex h-full min-h-0 flex-col" data-image-tool={tool}>
      {header}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col bg-sunken">
          {tool === 'imgCrop' && selectedCard?.info && cards.length > 0 && <CropStage card={selectedCard} opts={opts} setOpts={setOpts} />}
          {tool === 'imgBlur' && selectedCard?.info && cards.length > 0 && (
            <BlurStage card={selectedCard} style={opts.hideStyle} onRegions={(regions) => setCards((now) => now.map((c) => (c.key === selectedCard.key ? { ...c, regions } : c)))} />
          )}
          {marksTool && selectedCard?.info && cards.length > 0 && (
            <MarksStage
              card={selectedCard}
              layers={opts.layers}
              selected={layerSel}
              onSelect={setLayerSel}
              onChange={(id, p) => setLayers((now) => now.map((l) => (l.id === id ? { ...l, ...p } : l)))}
              bands={tool === 'imgMeme' ? memeBands(opts) : undefined}
            />
          )}
          <div className={clsx('min-h-0 overflow-y-auto p-6', stageTool && selectedCard?.info ? 'max-h-[248px] shrink-0 border-t border-line py-4' : 'flex-1')}>
            {cards.length === 0 ? (
              <button
                type="button"
                onClick={() => void pick()}
                className="mx-auto mt-10 flex w-full max-w-xl flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-line bg-surface px-6 py-14 text-center transition-colors hover:border-accent hover:bg-accent-soft/40"
                data-imgtool-empty=""
              >
                <span className="flex h-14 w-14 items-center justify-center rounded-full bg-accent-soft text-accent">
                  <Upload size={26} />
                </span>
                <span className="text-[15px] font-semibold">{t(`tool.${tool}.empty`)}</span>
                <span className="max-w-md text-[13px] text-muted">{t('img.emptyHint')}</span>
                <span className="mt-1 rounded-full bg-accent px-4 py-1.5 text-[13px] font-medium text-accent-ink">{t('images.choose')}</span>
              </button>
            ) : (
              <div className={clsx('flex flex-wrap gap-4', stageTool && 'flex-nowrap')}>
                {cards.map((card, i) => {
                  const info = card.info
                  const turned = card.rotate === 90 || card.rotate === 270
                  const boxH = stageTool ? 120 : CARD
                  const width = stageTool ? 132 : CARD
                  const ratio = info ? (turned ? info.width / info.height : info.height / info.width) : 1
                  const shownW = Math.min(width - 20, (boxH - 20) / ratio)
                  const shownH = shownW * ratio
                  const line = info ? previewLine(tool, opts, card, t) : null
                  return (
                    <div
                      key={card.key}
                      draggable={phase !== 'running'}
                      data-image-card=""
                      onClick={() => setSelected(card.key)}
                      onDragStart={(e) => {
                        setDragging(card.key)
                        e.dataTransfer.effectAllowed = 'move'
                      }}
                      onDragEnd={() => {
                        setDragging(null)
                        setDropAt(null)
                      }}
                      onDragOver={(e) => {
                        if (!dragging) return
                        e.preventDefault()
                        const r = e.currentTarget.getBoundingClientRect()
                        const rtl = document.documentElement.dir === 'rtl'
                        const first = rtl ? e.clientX > r.left + r.width / 2 : e.clientX < r.left + r.width / 2
                        setDropAt(first ? i : i + 1)
                      }}
                      onDrop={(e) => {
                        e.preventDefault()
                        const from = cards.findIndex((x) => x.key === dragging)
                        if (from >= 0 && dropAt !== null && dropAt !== from && dropAt !== from + 1) move(from, dropAt)
                        setDragging(null)
                        setDropAt(null)
                      }}
                      className={clsx(
                        'group relative flex shrink-0 cursor-pointer flex-col overflow-hidden rounded-xl border bg-surface shadow-sm transition-shadow hover:shadow-md',
                        (stageTool || tool === 'imgInfo') && selectedCard?.key === card.key ? 'border-accent ring-3 ring-accent/20' : 'border-line',
                        dragging === card.key && 'opacity-40'
                      )}
                      style={{ width }}
                    >
                      {dropAt === i && <span className="absolute -start-2.5 top-0 z-10 h-full w-1 rounded bg-accent" />}
                      {dropAt === i + 1 && i === cards.length - 1 && <span className="absolute -end-2.5 top-0 z-10 h-full w-1 rounded bg-accent" />}
                      <div className="relative flex items-center justify-center bg-[repeating-conic-gradient(var(--surface-2)_0_25%,var(--surface)_0_50%)] bg-[length:14px_14px]" style={{ height: boxH }}>
                        {info ? (
                          <img
                            src={info.preview}
                            alt=""
                            draggable={false}
                            className="max-w-none rounded-[2px] shadow-sm transition-transform duration-200"
                            style={{ width: turned ? shownH : shownW, height: turned ? shownW : shownH, transform: `rotate(${card.rotate}deg)` }}
                          />
                        ) : card.failed ? (
                          <span className="flex flex-col items-center gap-1 px-3 text-center text-[11px] text-danger">
                            <CircleAlert size={20} />
                            {t('cannotRead')}
                          </span>
                        ) : (
                          <Spinner />
                        )}
                        {tool === 'imgGif' && <span className="absolute start-2 top-2 flex h-5 min-w-5 items-center justify-center rounded-full bg-ink/75 px-1.5 text-[11px] font-semibold text-surface tabular-nums">{i + 1}</span>}
                        {info && info.frames > 1 && info.format !== 'pdf' && (
                          <span className="absolute start-2 bottom-2 rounded-full bg-ink/75 px-1.5 py-px text-[10px] font-semibold text-surface">{t('img.frames', { count: num(language, info.frames) })}</span>
                        )}
                        {card.status === 'working' && (
                          <span className="absolute inset-0 flex items-center justify-center bg-surface/60">
                            <Spinner size={22} />
                          </span>
                        )}
                        {card.status === 'done' && <CircleCheck size={22} className="absolute end-2 bottom-2 rounded-full bg-surface text-ok" />}
                        {phase !== 'running' && (
                          <div className="absolute end-2 top-2 hidden gap-0.5 rounded-lg border border-line bg-surface/95 p-0.5 shadow-md group-hover:flex" dir="ltr">
                            {tool === 'imgRotate' && (
                              <>
                                <CardAction label={t('rotateLeft')} onClick={() => turnCard(card.key, -90)}>
                                  <RotateCcw size={14} />
                                </CardAction>
                                <CardAction label={t('rotateRight')} onClick={() => turnCard(card.key, 90)}>
                                  <RotateCw size={14} />
                                </CardAction>
                              </>
                            )}
                            <CardAction
                              label={t('remove')}
                              danger
                              onClick={() => {
                                setCards((now) => now.filter((x) => x.key !== card.key))
                                if (selected === card.key) setSelected(null)
                              }}
                            >
                              <Trash2 size={14} />
                            </CardAction>
                          </div>
                        )}
                      </div>
                      <div className="flex flex-col gap-0.5 border-t border-line px-2.5 py-2">
                        <p className={clsx('truncate text-[12px] font-medium', card.failed && 'text-danger')} dir="auto" title={card.failed ? `${card.path}\n${card.failed}` : card.path}>
                          {card.name}
                        </p>
                        <p className="truncate text-[11px] text-muted tabular-nums" dir="ltr">
                          {info ? `${info.width} × ${info.height} · ${formatSpec(info.format).label} · ${formatBytes(language, info.size)}` : ' '}
                        </p>
                        {card.status === 'failed' ? (
                          <p className="truncate text-[11px] text-danger" title={card.error}>
                            {t('img.failedOne')}
                          </p>
                        ) : line ? (
                          <p className="flex items-center gap-1 truncate text-[11px] font-medium text-accent" dir="auto">
                            <ArrowRight size={11} className="shrink-0 rtl:rotate-180" />
                            <span className="truncate">{line}</span>
                          </p>
                        ) : null}
                      </div>
                    </div>
                  )
                })}
                {phase !== 'running' && (
                  <button
                    type="button"
                    onClick={() => void pick()}
                    title={t('addPictures')}
                    className="flex shrink-0 flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-line text-muted transition-colors hover:border-accent hover:text-accent"
                    style={{ width: stageTool ? 132 : CARD, minHeight: (stageTool ? 120 : CARD) + 62 }}
                  >
                    <Plus size={26} />
                    <span className="text-[12px] font-medium">{t('images.addMore')}</span>
                  </button>
                )}
              </div>
            )}
          </div>
        </div>

        <aside className="flex w-[312px] shrink-0 flex-col border-s border-line bg-surface" data-imgtool-options="">
          <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-5">{optionsBody()}</div>
          <footer className="flex flex-col gap-2 border-t border-line p-4">
            {phase === 'running' ? (
              <RunProgress tool={tool} finished={finished} total={usable.length} progress={progress} started={cardStarted} onStop={tool !== 'imgGif' ? () => (stop.current = true) : undefined} />
            ) : (
              <>
                {hasResults && replaceable && (
                  <p className="flex items-start gap-1.5 text-[11px] leading-snug text-muted" data-replaces-note="">
                    <RefreshCw size={12} className="mt-0.5 shrink-0" />
                    {t('img.replacesNote')}
                  </p>
                )}
                <button
                  type="button"
                  disabled={usable.length < minimum || noMarks || (tool === 'imgBlur' && cards.some((c) => c.detecting))}
                  onClick={() => void run()}
                  className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-accent px-3 text-[14px] font-semibold text-accent-ink shadow-sm transition-[filter] hover:brightness-110 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-45"
                  data-imgtool-run=""
                >
                  <Icon size={17} className="shrink-0" />
                  <span className="truncate">{usable.length === 1 ? t(`act.${tool}.one`) : t(`act.${tool}`, { count: usable.length })}</span>
                </button>
              </>
            )}
            {tool === 'imgGif' && usable.length < 2 && phase !== 'running' && <p className="text-center text-[11px] text-muted">{t('img.gifNeedsTwo')}</p>}
          </footer>
        </aside>
      </div>
    </div>
  )
}

function FolderChoice({ active, label, hint, onClick }: { active: boolean; label: string; hint: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={clsx('flex items-center gap-3 rounded-xl border px-3 py-2 text-start', active ? 'border-accent bg-accent-soft/60 ring-3 ring-accent/15' : 'border-line hover:border-faint')}
    >
      <span className={clsx('flex h-7 w-7 shrink-0 items-center justify-center rounded-lg', active ? 'bg-accent text-accent-ink' : 'bg-surface-2 text-muted')}>
        <FolderOpen size={15} />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-[13px] font-medium" dir="auto">
          {label}
        </span>
        <span className="line-clamp-2 text-[11px] leading-snug [overflow-wrap:anywhere] text-muted" dir="auto">
          {hint}
        </span>
      </span>
    </button>
  )
}

function CardAction({ label, onClick, danger, children }: { label: string; onClick: () => void; danger?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className={clsx('flex h-7 w-7 items-center justify-center rounded-md hover:bg-surface-2', danger ? 'text-danger' : 'text-muted hover:text-ink')}
    >
      {children}
    </button>
  )
}

/** The run's progress: pictures done, the AI's own progress on the current one, and the time left. */
function RunProgress({ tool, finished, total, progress, started, onStop }: { tool: ImageToolId; finished: number; total: number; progress: number | null; started: number; onStop?: () => void }) {
  const t = useT()
  const language = useStore((s) => s.settings?.language ?? 'en')
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const part = progress !== null && progress > 0 && progress < 1 ? progress : 0
  const overall = Math.min(1, (finished + part) / Math.max(1, total))
  // Time left on this picture, once the AI has done enough of it to tell.
  const left = part > 0.04 ? Math.round(((now - started) * (1 - part)) / part / 1000) : null
  const ai = tool === 'imgUpscale' || tool === 'imgRemoveBg' || tool === 'imgBlur'
  return (
    <div className="flex flex-col gap-2" data-imgtool-progress="">
      <div className="flex items-center gap-2 text-[12px] text-muted">
        <Spinner size={14} />
        <span className="flex-1">{t('img.working', { done: Math.min(finished + 1, total), total })}</span>
        {part > 0 && <span className="tabular-nums">{percent(language, Math.round(part * 100))}</span>}
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(overall * 100)}>
        <div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${Math.max(2, overall * 100)}%` }} />
      </div>
      {left !== null && left >= 3 && <p className="text-[11px] text-muted tabular-nums">{t('img.timeLeft', { seconds: num(language, left) })}</p>}
      {ai && <p className="text-[11px] leading-snug text-faint">{t('img.aiSlow')}</p>}
      {onStop && (
        <Button onClick={onStop} className="w-full">
          {t('img.stop')}
        </Button>
      )}
    </div>
  )
}

/** Tools offered after a result, in the order people chain them (iLoveIMG's "continue with"). */
const NEXT: ToolId[] = ['imgCompress', 'imgResize', 'imgCrop', 'imgConvert', 'imgUpscale', 'imgRemoveBg', 'imgWatermark', 'imgRotate', 'imgIcon', 'imagesToPdf', 'imgGif']

/** Tools whose settings live on the pictures (a box, marks, areas): adjusted on the board. */
const ON_PICTURES: ImageToolId[] = ['imgCrop', 'imgBlur', 'imgWatermark', 'imgMeme']

/**
 * After a run (decisions §77): the output large with before / after, the strip of results, and a
 * panel with what changed, how it was made, Open / Show in folder, the settings for "Try again"
 * (replacing these results), and "Continue with".
 */
function ResultView({
  tool,
  cards,
  options,
  changed,
  canRun,
  onTryAgain,
  onBack,
  onRestart
}: {
  tool: ImageToolId
  cards: Card[]
  /** The options panel, when the settings can change here; null when they are on the pictures or there are none. */
  options: ReactNode | null
  changed: boolean
  canRun: boolean
  onTryAgain: () => void
  onBack: () => void
  onRestart: () => void
}) {
  const t = useT()
  const language = useStore((s) => s.settings?.language ?? 'en')
  const ok = cards.filter((c) => c.status === 'done' && c.result)
  const failed = cards.filter((c) => c.status === 'failed')
  const outputs = tool === 'imgGif' ? (ok[0]?.result ? [ok[0].result] : []) : ok.flatMap((c) => c.results ?? (c.result ? [c.result] : []))
  const [focus, setFocus] = useState<string | null>(null)
  const current = ok.find((c) => c.key === focus) ?? ok[0] ?? null
  const before = ok.reduce((n, c) => n + (c.info?.size ?? 0), 0)
  const after = outputs.reduce((n, r) => n + r.size, 0)
  const saving = before > 0 ? Math.round((100 * (before - after)) / before) : 0
  const showSaving = (tool === 'imgCompress' || tool === 'imgConvert' || tool === 'imgToJpg' || tool === 'imgResize') && ok.length > 1
  const replaced = outputs.filter((r) => r.replaced).length
  const continueWith = (next: ToolId): void => {
    const paths = [...new Set(outputs.map((r) => r.path))]
    if (isImageTool(next)) handOverTo(next, paths)
    else {
      openTool(next)
      setTimeout(() => window.dispatchEvent(new CustomEvent('powerpdf:images-add', { detail: paths })), 300)
    }
  }
  const strip = tool !== 'imgGif' && tool !== 'imgFrames' && ok.length + failed.length > 1

  return (
    <div className="flex min-h-0 flex-1" data-imgtool-result="">
      <main className="flex min-w-0 flex-1 flex-col bg-sunken">
        {tool === 'imgFrames' ? (
          <div className="min-h-0 flex-1 overflow-y-auto p-6">
            <div className="grid grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-3" data-frames-grid="">
              {outputs.slice(0, 120).map((r) => (
                <div key={r.path} className="flex flex-col items-center gap-1 rounded-lg border border-line bg-surface p-2" title={r.path}>
                  <ResultThumb path={r.path} size={92} />
                  <span className="w-full truncate text-center text-[11px] text-muted" dir="auto">
                    {r.path.split(/[\\/]/).pop()}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : current?.result && current.info ? (
          <CompareStage key={current.key} tool={tool} before={{ path: current.path, info: current.info }} after={current.result} />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center text-muted">
            <CircleAlert size={28} className="text-danger" />
            <p className="text-[14px] font-medium text-ink">{t('img.noneDone')}</p>
          </div>
        )}
        {strip && (
          <ResultStrip
            items={cards
              .filter((c) => (c.status === 'done' && c.result) || c.status === 'failed')
              .map((c) => ({ key: c.key, name: c.name, preview: c.info?.preview, result: c.status === 'done' ? c.result : undefined, error: c.error, before: c.info ?? undefined }))}
            selected={current?.key ?? null}
            onSelect={setFocus}
          />
        )}
      </main>

      <aside className="flex w-[340px] shrink-0 flex-col border-s border-line bg-surface" data-imgtool-result-panel="">
        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-5">
          <section className="flex flex-col gap-2">
            <h2 className="flex items-center gap-2 text-[17px] font-semibold tracking-tight">
              {ok.length ? <CircleCheck size={20} className="shrink-0 text-ok" /> : <CircleAlert size={20} className="shrink-0 text-danger" />}
              <span>{!ok.length ? t('img.noneDone') : outputs.length === 1 ? t('img.doneOne') : t('img.doneTitle', { count: num(language, outputs.length) })}</span>
            </h2>
            {showSaving && (
              <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-sunken px-3 py-2" data-imgtool-saving="">
                <span className="text-[12px] text-muted tabular-nums">{formatBytes(language, before)}</span>
                <ArrowRight size={13} className="text-faint rtl:rotate-180" />
                <span className="text-[14px] font-semibold tabular-nums">{formatBytes(language, after)}</span>
                {saving > 0 ? (
                  <span className="rounded-full bg-ok/12 px-2 py-0.5 text-[12px] font-semibold text-ok">{t('img.saved', { percent: num(language, saving) })}</span>
                ) : saving < 0 ? (
                  <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[12px] text-muted">{t('img.bigger', { percent: num(language, -saving) })}</span>
                ) : null}
              </div>
            )}
            {tool === 'imgFrames' && outputs.length > 0 && <p className="text-[12px] text-muted">{t('img.framesWritten', { count: num(language, outputs.length) })}</p>}
            {replaced > 0 && (
              <p className="flex items-center gap-1.5 text-[12px] text-muted" data-replaced="">
                <RefreshCw size={13} className="shrink-0" />
                {t('img.replaced')}
              </p>
            )}
            {ok.some((c) => c.result?.missedTarget) && <p className="text-[12px] text-warn">{t('img.missedTarget')}</p>}
            {failed.length > 0 && (
              <div className="flex flex-col gap-1 rounded-lg border border-danger/30 px-3 py-2">
                <h3 className="text-[12px] font-semibold text-danger">{t('img.failedCount', { count: failed.length })}</h3>
                {failed.map((c) => (
                  <p key={c.key} className="truncate text-[11px] text-muted" dir="auto" title={c.error}>
                    {c.name}: {c.error}
                  </p>
                ))}
              </div>
            )}
          </section>

          {current?.result && tool !== 'imgFrames' && (
            <section className="flex flex-col gap-3" data-this-result="">
              <div className="flex items-center gap-3">
                <ResultThumb path={current.result.path} fallback={current.info?.preview} size={52} />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-[13px] font-semibold" dir="auto" title={current.result.path}>
                    {current.result.path.split(/[\\/]/).pop()}
                  </span>
                  <span className="truncate text-[11px] text-muted" dir="auto" title={current.result.path}>
                    {current.result.path.split(/[\\/]/).slice(0, -1).join('\\')}
                  </span>
                </span>
              </div>
              <MethodLine result={current.result} />
              {current.info && <ResultFacts before={current.info} result={current.result} />}
              <div className="flex flex-wrap gap-2">
                <Button variant="primary" icon={<Eye size={15} />} onClick={() => void openPicture(current.result!.path)} data-open-viewer="">
                  {t('img.openViewer')}
                </Button>
                <Button icon={<FolderOpen size={15} />} onClick={() => void window.api.showInFolder(current.result!.path)}>
                  {t('showInFolder')}
                </Button>
              </div>
            </section>
          )}
          {tool === 'imgFrames' && outputs[0] && (
            <Button variant="primary" icon={<FolderOpen size={15} />} onClick={() => void window.api.showInFolder(outputs[0]!.path)}>
              {t('showInFolder')}
            </Button>
          )}

          {options !== null ? (
            <section className="flex flex-col gap-4 border-t border-line pt-4" data-imgtool-adjust="">
              <div className="flex flex-col gap-0.5">
                <h3 className="flex items-center gap-1.5 text-[13px] font-semibold">
                  <SlidersHorizontal size={14} className="text-muted" />
                  {t('img.adjust')}
                </h3>
                <p className="text-[11px] leading-snug text-muted">{t('img.adjustHint')}</p>
              </div>
              {options}
            </section>
          ) : ON_PICTURES.includes(tool) ? (
            <section className="flex flex-col gap-2 border-t border-line pt-4" data-imgtool-adjust="">
              <h3 className="flex items-center gap-1.5 text-[13px] font-semibold">
                <SlidersHorizontal size={14} className="text-muted" />
                {t('img.adjust')}
              </h3>
              <p className="text-[11px] leading-snug text-muted">{t('img.adjustOnPicturesHint')}</p>
              <Button icon={<SlidersHorizontal size={15} />} onClick={onBack} className="self-start" data-adjust-on-pictures="">
                {t('img.adjustOnPictures')}
              </Button>
            </section>
          ) : null}

          {outputs.length > 0 && tool !== 'imgFrames' && (
            <section className="flex flex-col gap-2 border-t border-line pt-4">
              <h3 className="text-[11px] font-semibold tracking-wider text-muted uppercase">{t('img.continue')}</h3>
              <div className="grid grid-cols-2 gap-1.5" data-continue-with="">
                {NEXT.filter((n) => n !== tool).map((n) => {
                  const { icon: NextIcon, hue: h } = toolEntry(n)
                  return (
                    <button
                      key={n}
                      type="button"
                      onClick={() => continueWith(n)}
                      title={t(`tool.${n}`)}
                      className="flex min-w-0 items-center gap-2 rounded-lg border border-line px-2.5 py-2 text-start text-[12px] font-medium transition-colors hover:border-faint hover:bg-surface-2"
                    >
                      <NextIcon size={16} style={{ color: `hsl(${h} 68% 46%)` }} className="shrink-0" />
                      <span className="truncate">{t(`tool.${n}`)}</span>
                    </button>
                  )
                })}
              </div>
            </section>
          )}
        </div>
        <footer className="flex flex-col gap-2 border-t border-line p-4">
          {options !== null && (
            <>
              <button
                type="button"
                disabled={!changed || !canRun}
                onClick={onTryAgain}
                title={!changed ? t('img.tryAgainSame') : t('img.tryAgainNote')}
                className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-accent px-3 text-[14px] font-semibold text-accent-ink shadow-sm transition-[filter] hover:brightness-110 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-muted disabled:shadow-none"
                data-imgtool-tryagain=""
              >
                <RefreshCw size={16} className="shrink-0" />
                <span className="truncate">{t('img.tryAgain')}</span>
              </button>
              <p className="text-center text-[11px] leading-snug text-muted">{changed ? t('img.tryAgainNote') : t('img.tryAgainSame')}</p>
            </>
          )}
          <div className="flex flex-wrap justify-center gap-1">
            <Button variant="ghost" onClick={onBack}>
              {t('img.backToPictures')}
            </Button>
            <Button variant="ghost" onClick={onRestart}>
              {t('img.startOver')}
            </Button>
          </div>
        </footer>
      </aside>
    </div>
  )
}
