import type { PpmApi } from '../shared/api'

declare global {
  interface Window {
    ppm: PpmApi
  }
}
export {}
