import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  base: '/',
  plugins: [
    vue(),
    tailwindcss(),
    {
      name: 'novai-dev-api-proxy',
      configureServer(server) {
        server.middlewares.use('/api-proxy', async (req, res) => {
          const targetBase = req.headers['x-target-base']

          if (typeof targetBase !== 'string' || !targetBase.trim()) {
            res.statusCode = 400
            res.end('Missing x-target-base header')
            return
          }

          try {
            const requestBody = await readRequestBody(req)
            const targetPath = normalizeProxyPath(req.url)
            const targetUrl = new URL(targetPath, ensureTrailingSlash(targetBase))
            const response = await fetch(targetUrl, {
              method: req.method,
              headers: filterProxyHeaders(req.headers, targetBase),
              body: canHaveBody(req.method) ? requestBody : undefined,
            })

            res.statusCode = response.status

            response.headers.forEach((value, key) => {
              if (key.toLowerCase() === 'content-encoding') {
                return
              }

              res.setHeader(key, value)
            })

            const buffer = Buffer.from(await response.arrayBuffer())
            res.end(buffer)
          } catch (error) {
            res.statusCode = 502
            res.end(error instanceof Error ? error.message : 'Proxy request failed')
          }
        })
      },
    },
  ],
})

function canHaveBody(method) {
  return method && !['GET', 'HEAD'].includes(method.toUpperCase())
}

function filterProxyHeaders(headers, targetBase) {
  const nextHeaders = {}

  for (const [key, value] of Object.entries(headers)) {
    if (!value) {
      continue
    }

    const lowerKey = key.toLowerCase()

    if (lowerKey === 'host' || lowerKey === 'content-length' || lowerKey === 'x-target-base') {
      continue
    }

    nextHeaders[key] = Array.isArray(value) ? value.join(', ') : value
  }

  nextHeaders.origin = targetBase
  return nextHeaders
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []

    req.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    })

    req.on('end', () => {
      resolve(chunks.length > 0 ? Buffer.concat(chunks) : undefined)
    })

    req.on('error', reject)
  })
}

function normalizeProxyPath(url) {
  const rawPath = (url || '/').split('?')[0] || '/'
  return rawPath.replace(/^\/+/, '') || ''
}

function ensureTrailingSlash(value) {
  return value.endsWith('/') ? value : `${value}/`
}
