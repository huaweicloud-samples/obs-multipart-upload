import "./App.css"
import { Uploader } from "./utils/upload"
import { useEffect, useState } from "react"

// 运行时配置由页面函数注入（functions/index.js 生成的 HTML 壳）：
// apiBase = APIG 分组调试域名下的 /api 前缀；stage = 调用该发布环境所需的 X-Stage 头；
// obsAssetPrefix = 公共读资产桶前缀。前端代码不写任何环境相关地址。
const config = window.__CONFIG__ || {}
const API_BASE_URL = config.apiBase || ""
const API_STAGE = config.stage || ""

function App() {
  const [file, setFile] = useState(undefined)
  const [pgvalue, setPgvalue] = useState(undefined)
  const [perf, setPerf] = useState(undefined)
  const [partsize, setPartsize] = useState(undefined)
  const [numuploads, setNumuploads] = useState(undefined)

  useEffect(() => {
    if (file) {
      const uploaderOptions = {
        file: file,
        baseURL: API_BASE_URL,
        stage: API_STAGE,
        chunkSize: partsize,
        threadsQuantity: numuploads,
      }

      let percentage = undefined
      setPgvalue(0)
      setPerf("-")
      const uploader = new Uploader(uploaderOptions)
      const tBegin = performance.now()
      uploader
        .onProgress(({ percentage: newPercentage }) => {
          // to avoid the same percentage to be logged twice
          if (percentage === 100) {
            setPerf((performance.now() - tBegin) / 1000)
          }
          if (newPercentage !== percentage) {
            percentage = newPercentage
            setPgvalue(percentage)
          }
        })
        .onError((error) => {
          setFile(undefined)
          console.error(error)
        })

      uploader.start()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file])

  return (
    <div>
      <div style={{ backgroundColor: "#e2e2e2", padding: "20px", margin: "10px" }}>
        <strong style={{ display: "block" }}>Step 1 - Choose part size (MB)</strong><br/>
        <input type="number" id="pu" min="5" max="500"
               onChange={(e) => {
                 setPartsize(e.target?.value)
               }}
        />
      </div>
      <div style={{ backgroundColor: "#e2e2e2", padding: "20px", margin: "10px" }}>
        <strong style={{ display: "block" }}>Step 2 - Choose number of parallel uploads</strong><br/>
        <input type="number" id="pu" min="5" max="10"
               onChange={(e) => {
                 setNumuploads(e.target?.value)
               }}
        />
      </div>
      <div style={{ backgroundColor: "#e2e2e2", padding: "20px", margin: "10px" }}>
        <strong style={{ display: "block" }}>Step 3 - Choose a file</strong><br/>
        <input type="file" id="fileinput"
               onChange={(e) => {
                 setFile(e.target?.files?.[0])
               }}
        />
      </div>
      <div style={{ backgroundColor: "#e2e2e2", padding: "20px", margin: "10px" }}>
        <strong style={{ display: "block" }}>Step 4 - Monitor</strong><br/>
        <span id="output">{pgvalue}% ({perf} sec)</span>
      </div>
    </div>
  )
}

export default App
