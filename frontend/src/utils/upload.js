import axios from "axios"

// initializing axios
const api = axios.create({
  baseURL: "/",
})

// original source: https://github.com/pilovm/multithreaded-uploader/blob/master/frontend/uploader.js
export class Uploader {
  constructor(options) {
    // this must be bigger than or equal to 5MB,
    // otherwise object storage responds with:
    // "Your proposed upload is smaller than the minimum allowed size"
    // （OBS 分片最小 100KB；这里保留 5MB 下限，比分片最小值更保守，重试粒度也更稳）
    options.chunkSize = options.chunkSize || 0
    this.chunkSize = Math.max((1024 * 1024 * options.chunkSize), (1024 * 1024 * 5))
    // number of parallel uploads
    options.threadsQuantity = options.threadsQuantity || 0
    this.threadsQuantity = Math.min(options.threadsQuantity || 5, 15)
    // adjust the timeout value to activate exponential backoff retry strategy
    this.timeout = 0
    this.file = options.file
    this.fileName = options.fileName
    this.aborted = false
    this.uploadedSize = 0
    this.progressCache = {}
    this.activeConnections = {}
    this.parts = []
    this.uploadedParts = []
    this.fileId = null
    this.fileKey = null
    this.onProgressFn = () => {}
    this.onErrorFn = () => {}
    this.baseURL = options.baseURL
    // APIG 分组调试域名按发布环境路由，浏览器调用 API 时需携带 X-Stage 头
    //（由页面函数写入 window.__CONFIG__.stage 注入）；留空时不带该头。
    this.stage = options.stage || ""
  }

  start() {
    this.initialize()
  }

  apiRequest(url, method, data) {
    const headers = {}
    if (this.stage) {
      headers["X-Stage"] = this.stage
    }
    return api.request({
      url,
      method,
      data,
      baseURL: this.baseURL,
      headers,
    })
  }

  async initialize() {
    try {
      // adding the the file extension (if present) to fileName
      let fileName = this.file.name

      // initializing the multipart request
      const initializationUploadInput = {
        name: fileName,
      }
      const initializeResponse = await this.apiRequest("/initialize", "POST", initializationUploadInput)

      const fileDataOutput = initializeResponse.data

      this.fileId = fileDataOutput.fileId
      this.fileKey = fileDataOutput.fileKey

      // retrieving the pre-signed URLs
      const numberOfparts = Math.ceil(this.file.size / this.chunkSize)

      const multipartFileDataInput = {
        fileId: this.fileId,
        fileKey: this.fileKey,
        parts: numberOfparts,
      }

      const urlsResponse = await this.apiRequest("/getPreSignedUrls", "POST", multipartFileDataInput)

      const newParts = urlsResponse.data.parts
      this.parts.push(...newParts)

      this.sendNext()
    } catch (error) {
      await this.complete(error)
    }
  }

  sendNext(retry=0) {
    const activeConnections = Object.keys(this.activeConnections).length

    if (activeConnections >= this.threadsQuantity) {
      return
    }

    if (!this.parts.length) {
      if (!activeConnections) {
        this.complete()
      }

      return
    }

    const part = this.parts.pop()
    if (this.file && part) {
      const sentSize = (part.PartNumber - 1) * this.chunkSize
      // slice 显式传空 MIME 类型：浏览器 XHR 对非空 type 的 Blob 会自动附加
      // Content-Type 请求头，而预签名 URL 按“空 Content-Type”签名——不传空
      // 类型会导致服务端签名校验失败（403 SignatureDoesNotMatch）。
      const chunk = this.file.slice(sentSize, sentSize + this.chunkSize, "")

      const sendChunkStarted = () => {
        this.sendNext()
      }

      this.sendChunk(chunk, part, sendChunkStarted)
        .then(() => {
          this.sendNext()
        })
        .catch((error) => {
          if (retry <= 6){
            retry++
            const wait = (ms) => new Promise((res) => setTimeout(res, ms));
            //exponential backoff retry before giving up
            console.log(`Part#${part.PartNumber} failed to upload, backing off ${2 ** retry * 100} before retrying...`)
            wait(2 ** retry * 100).then(() => {
              this.parts.push(part)
              this.sendNext(retry)
            })
          }else{
            console.log(`Part#${part.PartNumber} failed to upload, giving up`)
            this.complete(error)
          }
        })
    }
  }

  async complete(error) {
    if (error && !this.aborted) {
      this.onErrorFn(error)
      return
    }

    if (error) {
      this.onErrorFn(error)
      return
    }

    try {
      await this.sendCompleteRequest()
    } catch (error) {
      this.onErrorFn(error)
    }
  }

  async sendCompleteRequest() {
    if (this.fileId && this.fileKey) {
      const finalizationMultiPartInput = {
        fileId: this.fileId,
        fileKey: this.fileKey,
        parts: this.uploadedParts,
      }

      await this.apiRequest("/finalize", "POST", finalizationMultiPartInput)
    }
  }

  sendChunk(chunk, part, sendChunkStarted) {
    return new Promise((resolve, reject) => {
      this.upload(chunk, part, sendChunkStarted)
        .then((status) => {
          if (status !== 200) {
            reject(new Error("Failed chunk upload"))
            return
          }

          resolve()
        })
        .catch((error) => {
          reject(error)
        })
    })
  }

  handleProgress(part, event) {
    if (this.file) {
      if (event.type === "progress" || event.type === "error" || event.type === "abort") {
        this.progressCache[part] = event.loaded
      }

      if (event.type === "uploaded") {
        this.uploadedSize += this.progressCache[part] || 0
        delete this.progressCache[part]
      }

      const inProgress = Object.keys(this.progressCache)
        .map(Number)
        .reduce((memo, id) => (memo += this.progressCache[id]), 0)

      const sent = Math.min(this.uploadedSize + inProgress, this.file.size)

      const total = this.file.size

      const percentage = Math.round((sent / total) * 100)

      this.onProgressFn({
        sent: sent,
        total: total,
        percentage: percentage,
      })
    }
  }

  upload(file, part, sendChunkStarted) {
    // uploading each part with its pre-signed URL
    return new Promise((resolve, reject) => {
      const throwXHRError = (error, part, abortFx) => {
        delete this.activeConnections[part.PartNumber - 1]
        reject(error)
        window.removeEventListener('offline', abortFx)
      }
      if (this.fileId && this.fileKey) {
        if(!window.navigator.onLine)
          reject(new Error("System is offline"))

        const xhr = (this.activeConnections[part.PartNumber - 1] = new XMLHttpRequest())
        xhr.timeout = this.timeout
        sendChunkStarted()

        const progressListener = this.handleProgress.bind(this, part.PartNumber - 1)

        xhr.upload.addEventListener("progress", progressListener)

        xhr.addEventListener("error", progressListener)
        xhr.addEventListener("abort", progressListener)
        xhr.addEventListener("loadend", progressListener)

        xhr.open("PUT", part.signedUrl)
        const abortXHR = () => xhr.abort()
        xhr.onreadystatechange = () => {
          if (xhr.readyState === 4 && xhr.status === 200) {
            const ETag = xhr.getResponseHeader("ETag")

            if (ETag) {
              const uploadedPart = {
                PartNumber: part.PartNumber,
                ETag: ETag.replaceAll('"', ""),
              }

              this.uploadedParts.push(uploadedPart)

              resolve(xhr.status)
              delete this.activeConnections[part.PartNumber - 1]
              window.removeEventListener('offline', abortXHR)
            }
          }
        }

        xhr.onerror = (error) => {
          throwXHRError(error, part, abortXHR)
        }
        xhr.ontimeout = (error) => {
          throwXHRError(error, part, abortXHR)
        }
        xhr.onabort = () => {
          throwXHRError(new Error("Upload canceled by user or system"), part)
        }
        window.addEventListener('offline', abortXHR);
        xhr.send(file)
      }
    })
  }

  onProgress(onProgress) {
    this.onProgressFn = onProgress
    return this
  }

  onError(onError) {
    this.onErrorFn = onError
    return this
  }

  abort() {
    Object.keys(this.activeConnections)
      .map(Number)
      .forEach((id) => {
        this.activeConnections[id].abort()
      })

    this.aborted = true
  }
}
