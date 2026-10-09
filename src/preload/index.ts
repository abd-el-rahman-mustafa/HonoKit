import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC, type PowerApi, type Progress, type UpdateState } from '@shared/ipc'
import type { OpenRequest } from '@shared/opening'

/**
 * The renderer's entire surface area. Runs sandboxed: it can reach Electron's
 * messaging and nothing else, and every call is checked again in the main process.
 */

const call =
  (method: string) =>
  (...args: unknown[]): Promise<never> =>
    ipcRenderer.invoke(IPC.call, method, args) as Promise<never>

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const handler = (_event: unknown, value: T): void => listener(value)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const argument = (name: string): string => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? ''

const api: PowerApi & { updateState(): Promise<UpdateState> } = {
  version: argument('powerpdf-version'),
  platform: process.platform,
  system: argument('powerpdf-system'),

  open: call('open'),
  fileThumbnail: call('fileThumbnail'),
  close: call('close'),
  apply: call('apply'),
  undo: call('undo'),
  redo: call('redo'),
  save: call('save'),
  shareFile: call('shareFile'),
  shareAction: call('shareAction'),
  startDragOut: (path: string) => ipcRenderer.send(IPC.dragOut, path),
  authorize: call('authorize'),
  search: call('search'),
  pageText: call('pageText'),
  selectText: call('selectText'),
  copyText: call('copyText'),
  spellCheck: call('spellCheck'),
  spellSuggest: call('spellSuggest'),
  spellAdd: call('spellAdd'),
  preview: call('preview'),
  pageParagraphs: call('pageParagraphs'),
  paragraphFonts: call('paragraphFonts'),
  pagePictures: call('pagePictures'),
  whiteMargins: call('whiteMargins'),
  systemFonts: call('systemFonts'),
  pageMarkups: call('pageMarkups'),
  outline: call('outline'),
  pageLinks: call('pageLinks'),
  pictureInfo: call('pictureInfo'),
  extract: call('extract'),
  merge: call('merge'),
  imagesToPdf: call('imagesToPdf'),
  newBlank: call('newBlank'),
  formFields: call('formFields'),
  signatures: call('signatures'),
  detectFields: call('detectFields'),
  documentFonts: call('documentFonts'),
  findFont: call('findFont'),
  runBatch: call('runBatch'),
  pdfsIn: call('pdfsIn'),
  pickDigitalId: call('pickDigitalId'),
  createDigitalId: call('createDigitalId'),
  pickExportPath: call('pickExportPath'),
  createPdf: call('createPdf'),
  officeApps: call('officeApps'),
  pickConvertible: call('pickConvertible'),
  exportOffice: call('exportOffice'),
  openConverted: call('openConverted'),
  redactFind: call('redactFind'),
  redactMarks: call('redactMarks'),
  compare: call('compare'),
  comparePage: call('comparePage'),
  compareClose: call('compareClose'),
  pickTextFile: call('pickTextFile'),
  newFromTemplate: call('newFromTemplate'),
  templates: call('templates'),
  addTemplates: call('addTemplates'),
  removeTemplate: call('removeTemplate'),
  split: call('split'),
  exportImages: call('exportImages'),
  printers: call('printers'),
  printDoc: call('printDoc'),
  scanDetect: call('scanDetect'),
  scanFold: call('scanFold'),
  scanPreview: call('scanPreview'),
  scanPdfPictures: call('scanPdfPictures'),
  scanToPdf: call('scanToPdf'),
  scannerAcquire: call('scannerAcquire'),
  printerPreferences: call('printerPreferences'),
  printerSettings: call('printerSettings'),

  imageDescribe: call('imageDescribe'),
  imageMetadata: call('imageMetadata'),
  imageRun: call('imageRun'),
  imageAnimate: call('imageAnimate'),
  imageFrames: call('imageFrames'),
  imageDecode: call('imageDecode'),
  imageDetect: call('imageDetect'),
  imageSaveEdited: call('imageSaveEdited'),
  picturesBeside: call('picturesBeside'),
  rememberPicture: call('rememberPicture'),
  sharePicture: call('sharePicture'),
  pickAnyImages: call('pickAnyImages'),

  pickPdfs: call('pickPdfs'),
  pickOpenable: call('pickOpenable'),
  pickImages: call('pickImages'),
  pickSavePath: call('pickSavePath'),
  pickFolder: call('pickFolder'),
  pathForFile: (file) => webUtils.getPathForFile(file),
  showInFolder: call('showInFolder'),
  fileInfo: call('fileInfo'),
  openExternal: call('openExternal'),
  openLink: call('openLink'),

  getSettings: call('getSettings'),
  setSettings: call('setSettings'),
  forgetRecent: call('forgetRecent'),
  places: call('places'),
  listFolder: call('listFolder'),
  copyPath: call('copyPath'),
  quit: call('quit'),
  onConfirmQuit: (listener) => subscribe(IPC.confirmQuit, () => listener()),
  checkForUpdates: call('checkForUpdates'),
  downloadUpdate: call('downloadUpdate'),
  installUpdate: call('installUpdate'),
  updateState: call('updateState'),
  setUnsaved: (count, prompt) => ipcRenderer.send(IPC.unsaved, { count, prompt }),

  onProgress: (listener) => subscribe<Progress | null>(IPC.progress, listener),
  onUpdate: (listener) => subscribe<UpdateState>(IPC.update, listener),
  onOpenFiles: (listener) => subscribe<OpenRequest[]>(IPC.openFiles, listener),
  onEngineRestarted: (listener) => subscribe<string>(IPC.engine, () => listener())
}

contextBridge.exposeInMainWorld('api', api)
