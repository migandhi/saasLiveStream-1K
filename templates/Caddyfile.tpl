${API_DOMAIN} {
    encode gzip
    reverse_proxy 127.0.0.1:3000
}

${STREAM_DOMAIN} {
    # Backend REST API
    handle /api/* {
        encode gzip
        reverse_proxy 127.0.0.1:3000
    }

    # Authenticated WebSocket (Chat, Polls, Live Presence)
    handle /ws {
        reverse_proxy 127.0.0.1:3000
    }

    # Broadcaster WebRTC WHIP ingest (browser studio or OBS WHIP)
    @whip path_regexp ^/live/[^/]+/whip(/.*)?$
    handle @whip {
        reverse_proxy 127.0.0.1:8889
    }

    # Viewer LL-HLS playback (no gzip — video is already compressed)
    handle /live/* {
        reverse_proxy 127.0.0.1:8888 {
            flush_interval -1
        }
    }

    # Static Frontend
    handle {
        encode gzip
        root * /srv/www
        file_server
    }
}
