import type { PowerApi, UpdateState } from '../shared/ipc'

declare global {
  interface Window {
    api: PowerApi & { updateState(): Promise<UpdateState> }
  }
}

export {}
