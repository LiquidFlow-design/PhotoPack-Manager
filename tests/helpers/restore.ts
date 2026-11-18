import type { TestEnv } from './env'

export async function createRecoveryRestore(env: TestEnv, mediaId: number, targetDir: string | null = null) {
  const r = env.db.prepare("SELECT id FROM recovery_items WHERE media_id = ? AND status IN ('held','released')").get(mediaId) as { id: string }
  return env.engine.createRestoreJob(env.projectId, [r.id], targetDir)
}
