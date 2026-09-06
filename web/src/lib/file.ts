import { MAX_FILE_BYTES, MAX_FILE_CHUNK_BYTES, type WebRequest, type WebResult } from '@shared/web'

/** Check if a file is an image by MIME type or file extension. */
export function isImageFile(file: File): boolean {
  if (/^image\/(png|jpe?g|webp|gif|bmp|heic|heif)$/i.test(file.type)) return true
  return /\.(png|jpe?g|gif|webp|bmp|heic|heif)$/i.test(file.name)
}

/** Human-readable file size string (e.g. "120 B", "45.2 KB", "1.8 MB"). */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Extract all files from a drag-and-drop or clipboard event dataTransfer. */
export function allFilesFromDataTransfer(data: DataTransfer | null): File[] {
  if (!data) return []
  if (data.files?.length) {
    return [...data.files]
  }
  const items = data.items
  if (!items) return []
  const files: File[] = []
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (item.kind !== 'file') continue
    const file = item.getAsFile()
    if (file) files.push(file)
  }
  return files
}

export function bufferToBase64(buffer: ArrayBuffer): string {
  let binary = ''
  const bytes = new Uint8Array(buffer)
  const len = bytes.byteLength
  const chunkSize = 8192
  for (let i = 0; i < len; i += chunkSize) {
    const sub = bytes.subarray(i, Math.min(i + chunkSize, len))
    binary += String.fromCharCode.apply(null, sub as unknown as number[])
  }
  return btoa(binary)
}

/**
 * Upload a file (PDF, code, document, data, etc.) in chunks across the WebSocket.
 * Each chunk is bounded to MAX_FILE_CHUNK_BYTES so the frames never breach MAX_FRAME_BYTES.
 */
export async function uploadFileChunks(
  file: File,
  sessionId: string,
  request: (body: WebRequest) => Promise<WebResult>
): Promise<void> {
  if (file.size > MAX_FILE_BYTES) {
    throw new Error(`"${file.name}" is too large to upload (maximum ${formatFileSize(MAX_FILE_BYTES)}).`)
  }
  if (file.size === 0) {
    throw new Error(`"${file.name}" was empty.`)
  }

  const uploadId = `u_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const totalChunks = Math.max(1, Math.ceil(file.size / MAX_FILE_CHUNK_BYTES))

  for (let index = 0; index < totalChunks; index++) {
    const start = index * MAX_FILE_CHUNK_BYTES
    const end = Math.min(start + MAX_FILE_CHUNK_BYTES, file.size)
    const slice = file.slice(start, end)
    const arrayBuffer = await slice.arrayBuffer()
    const data = bufferToBase64(arrayBuffer)

    const result = await request({
      kind: 'upload-file',
      uploadId,
      sessionId,
      name: file.name,
      mime: file.type || undefined,
      index,
      totalChunks,
      data
    })

    if (result.kind === 'failed') {
      throw new Error(result.message || `Failed to upload "${file.name}".`)
    }
  }
}
