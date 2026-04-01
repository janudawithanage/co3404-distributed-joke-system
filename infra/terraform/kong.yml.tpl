# =============================================================================
# infra/terraform/kong.yml.tpl
#
# Terraform templatefile() source for Kong declarative configuration.
# Variables: vm1_private_ip, vm2_private_ip, vm3_private_ip, rate_limit_per_minute
#
# Rendered to infra/kong/kong.yml by the local_file resource in main.tf.
# Do NOT edit infra/kong/kong.yml directly -- edit this template instead.
# =============================================================================


_format_version: "3.0"
_transform: true

# =============================================================================
# Global Plugins
# Applied to every request that passes through Kong, regardless of route.
# =============================================================================
plugins:
  # Adds a unique Kong-Request-ID header to every response.
  # Use this to prove traffic is flowing through Kong in testing.
  - name: correlation-id
    config:
      header_name:      Kong-Request-ID
      generator:        uuid
      echo_downstream:  true

# =============================================================================
# Services and Routes
# =============================================================================
services:

  # ---------------------------------------------------------------------------
  # Joke Service — VM1 (${vm1_private_ip}:3000)
  #
  # Route 1: /joke   (prefix, strip_path=false)  → API endpoints
  #   Kong receives:   GET /joke/programming
  #   Forwards to:     GET http://${vm1_private_ip}:3000/joke/programming
  #
  # Route 2: /joke-ui (strip_path=true)           → Joke Machine frontend HTML
  #   Kong receives:   GET /joke-ui
  #   Forwards to:     GET http://${vm1_private_ip}:3000/
  #
  # Rate limiting: ${rate_limit_per_minute} requests/minute per client IP.
  # Demonstrating that a downstream service can be protected by Kong
  # without modifying the service itself.
  # ---------------------------------------------------------------------------
  - name: joke-service
    url:              http://${vm1_private_ip}:3000
    connect_timeout:  5000
    read_timeout:     10000
    write_timeout:    10000
    retries:          3

    routes:
      - name:           joke-route
        paths:          [/joke]
        strip_path:     false
        preserve_host:  false
        methods:        [GET, HEAD, OPTIONS]
        plugins:
          - name: rate-limiting
            config:
              minute:         ${rate_limit_per_minute}
              policy:         local
              error_code:     429
              error_message:  "Rate limit exceeded — Joke API allows ${rate_limit_per_minute} req/min. Retry after 60 seconds."
              hide_client_headers: false

      # Exposes the Joke Machine HTML frontend at /joke-ui through Kong
      - name:           joke-frontend-route
        paths:          [/joke-ui]
        strip_path:     true
        preserve_host:  false
        methods:        [GET, HEAD, OPTIONS]

  # ---------------------------------------------------------------------------
  # Submit Service - VM2 (${vm2_private_ip}:3200)
  #
  # GET  /submit -> HTML frontend
  # POST /submit -> Joke submission API (publishes to 'submit' queue)
  # GET  /types  -> Joke types via ECST cache (no HTTP proxy to joke-service)
  # GET  /docs   -> Swagger / OpenAPI documentation UI
  # ---------------------------------------------------------------------------
  - name: submit-service
    url:              http://${vm2_private_ip}:3200
    connect_timeout:  5000
    read_timeout:     10000
    write_timeout:    10000
    retries:          3

    routes:
      - name:           submit-frontend-route
        paths:          [/submit]
        strip_path:     true
        preserve_host:  false
        methods:        [GET, OPTIONS]

      - name:           submit-api-route
        paths:          [/submit]
        strip_path:     false
        preserve_host:  false
        methods:        [POST]
        plugins:
          - name: rate-limiting
            config:
              minute:        10
              policy:        local
              error_code:    429
              error_message: "Rate limit exceeded — Submit API allows 10 req/min. Retry after 60 seconds."
              hide_client_headers: false

      - name:           submit-types-route
        paths:          [/types]
        strip_path:     false
        preserve_host:  false
        methods:        [GET]

      - name:           docs-route
        paths:          [/docs]
        strip_path:     false
        preserve_host:  false
        methods:        [GET]

  # ---------------------------------------------------------------------------
  # Moderate Service - VM3 (${vm3_private_ip}:3300)
  # Runs on the dedicated moderation VM.
  #
  # Auth0 OIDC authentication is handled inside the service (not by Kong).
  #
  # IMPORTANT: Set AUTH0_BASE_URL to https://<KONG_PUBLIC_IP>  (no path suffix)
  #            Add https://<KONG_PUBLIC_IP>/callback to Auth0 Allowed Callbacks
  #            Add https://<KONG_PUBLIC_IP>/moderate-ui to Auth0 Allowed Logout URLs
  # ---------------------------------------------------------------------------
  - name: moderate-service
    url:              http://${vm3_private_ip}:3300
    connect_timeout:  5000
    read_timeout:     15000
    write_timeout:    10000
    retries:          2

    routes:
      - name:           moderate-frontend-route
        paths:          [/moderate-ui]
        strip_path:     true
        preserve_host:  false
        methods:        [GET, HEAD, OPTIONS]

      - name:           moderate-get-route
        paths:          [/moderate]
        strip_path:     false
        preserve_host:  false
        methods:        [GET, HEAD]

      - name:           moderated-post-route
        paths:          [/moderated]
        strip_path:     false
        preserve_host:  false
        methods:        [POST, OPTIONS]

      - name:           reject-route
        paths:          [/reject]
        strip_path:     false
        preserve_host:  false
        methods:        [POST, OPTIONS]

      - name:           moderate-auth-route
        paths:          [/login, /logout, /callback, /me]
        strip_path:     false
        preserve_host:  false
        methods:        [GET, POST, OPTIONS]

      - name:           moderate-types-route
        paths:          [/moderate-types]
        strip_path:     false
        preserve_host:  false
        methods:        [GET]

  # ---------------------------------------------------------------------------
  # RabbitMQ Management UI - VM2 (${vm2_private_ip}:15672)
  #
  # The management UI is a SPA that:
  #   - loads at /mq-admin/   (trailing slash required — strip_path removes prefix)
  #   - fetches static assets at /mq-admin/js/, /mq-admin/img/ etc
  #   - makes API calls to absolute /api/... paths
  # Route /mq-admin handles the page + static assets (strip_path=true).
  # Route /api handles the SPA's absolute API calls (strip_path=false).
  # Access: https://85.211.240.162/mq-admin/  credentials: guest / guest
  # ---------------------------------------------------------------------------
  - name: rabbitmq-management
    url:              http://${vm2_private_ip}:15672
    connect_timeout:  5000
    read_timeout:     10000
    write_timeout:    10000
    retries:          1

    routes:
      - name:           mq-admin-route
        paths:          [/mq-admin]
        strip_path:     true
        preserve_host:  false
        methods:        [GET, POST, PUT, DELETE, OPTIONS, HEAD]
        plugins:
          - name: ip-restriction
            config:
              allow:
                - 10.0.0.0/8   # Azure VNet only — use SSH tunnel for external access
                - 127.0.0.0/8  # Kong VM localhost

      - name:           mq-api-route
        paths:          [/api]
        strip_path:     false
        preserve_host:  false
        methods:        [GET, POST, PUT, DELETE, OPTIONS, HEAD]
        plugins:
          - name: ip-restriction
            config:
              allow:
                - 10.0.0.0/8
                - 127.0.0.0/8

  # ---------------------------------------------------------------------------
  # ETL Service — VM1 (co-located with joke-service on ${vm1_private_ip})
  # Health endpoint only — allows operators to verify ETL status via Kong.
  # ETL has no host port mapping by default; expose 3001:4001 in vm1-compose
  # to make this route reachable.
  # ---------------------------------------------------------------------------
  - name: etl-service
    url:              http://${vm1_private_ip}:3001
    connect_timeout:  5000
    read_timeout:     5000
    write_timeout:    5000
    retries:          1

    routes:
      - name:           etl-health-route
        paths:          [/etl-health]
        strip_path:     true
        preserve_host:  false
        methods:        [GET, HEAD]
