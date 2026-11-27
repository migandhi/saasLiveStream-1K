logLevel: warn
writeQueueSize: 1024

api: true
apiAddress: 127.0.0.1:9997

authMethod: http
authHTTPAddress: http://127.0.0.1:3000/api/mtx/auth
authHTTPExclude:
  - action: api
  - action: metrics
  - action: pprof

# ---------- Viewer Delivery: Low-Latency HLS (In-Memory) ----------
hls: true
hlsAddress: 127.0.0.1:8888
hlsVariant: lowLatency
hlsSegmentCount: 5
hlsSegmentDuration: 2s
hlsPartDuration: 400ms
hlsSegmentMaxSize: 50M
hlsAlwaysRemux: true
hlsTrustedProxies: ["127.0.0.1"]

# ---------- Broadcaster Ingest: RTMP (OBS) + WebRTC WHIP (Browser/OBS) ----------
rtmp: true
rtmpAddress: :1935

webrtc: true
webrtcAddress: 127.0.0.1:8889
webrtcLocalUDPAddress: :8189
webrtcLocalTCPAddress: :8189
webrtcIPsFromInterfaces: false
webrtcAdditionalHosts: ["${PUBLIC_IP}"]

# Disabled protocols (smaller attack surface)
srt: false
rtsp: false
moq: false

paths:
  "~^live/([a-zA-Z0-9_-]{4,64})$":
    source: publisher
