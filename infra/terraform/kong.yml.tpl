# =============================================================================
# infra/terraform/kong.yml.tpl
#
# Terraform templatefile() source for Kong declarative configuration.
# Variables: vm1_private_ip, vm2_private_ip, rate_limit_per_minute
#
# Rendered to infra/kong/kong.yml by the local_file resource in main.tf.
# Do NOT edit infra/kong/kong.yml directly — edit this template instead.
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
  # Route 2: /types  (strip_path=false)           → joke type list
  #
  # Route 3: /joke-ui (strip_path=true)           → Joke Machine frontend HTML
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

      # Exposes the Joke Machine HTML frontend at /joke-ui through Kong
      - name:           joke-frontend-route
        paths:          [/joke-ui]
        strip_path:     true
        preserve_host:  false
        methods:        [GET, OPTIONS]

    plugins:
      - name: rate-limiting
        config:
          minute:         ${rate_limit_per_minute}
          policy:         local          # "local" = per Kong node, fine for single-VM demo
          error_code:     429
          error_message:  "Rate limit exceeded — Joke API allows ${rate_limit_per_minute} req/min. Retry after 60 seconds."
          hide_client_headers: false    # expose X-RateLimit-Remaining-Minute header

  # ---------------------------------------------------------------------------
  # Submit Service — VM2 (${vm2_private_ip}:3200)
  #
  # Two routes are needed:
  #   1. GET  /submit  (strip_path=true)  → / on VM2  → serves the HTML frontend
  #   2. POST /submit  (strip_path=false) → /submit on VM2 → joke submission API
  #
  # A third route exposes /types so the frontend JS (fetch('/types')) can reach
  # the Submit service's proxy endpoint without leaving Kong.
  #
  # No rate limiting on submit — demonstrates per-service plugin configuration.
  # ---------------------------------------------------------------------------
  - name: submit-service
    url:              http://${vm2_private_ip}:3200
    connect_timeout:  5000
    read_timeout:     10000
    write_timeout:    10000
    retries:          3

    routes:
      # Serves the submit HTML frontend (express.static at /)
      - name:           submit-frontend-route
        paths:          [/submit]
        strip_path:     true
        preserve_host:  false
        methods:        [GET, OPTIONS]

      # Forwards POST /submit → POST /submit on VM2 (joke submission API)
      - name:           submit-api-route
        paths:          [/submit]
        strip_path:     false
        preserve_host:  false
        methods:        [POST]

      # Exposes /types so the frontend JS (fetch('/types')) works through Kong
      - name:           submit-types-route
        paths:          [/types]
        strip_path:     false
        preserve_host:  false
        methods:        [GET]

      # GET /docs — Swagger / OpenAPI documentation UI
      - name:           docs-route
        paths:          [/docs]
        strip_path:     false
        preserve_host:  false
        methods:        [GET]

  # ---------------------------------------------------------------------------
  # RabbitMQ Management UI — VM2 (${vm2_private_ip}:15672)
  #
  # GET /mq-admin  → RabbitMQ Management UI (credentials: RABBITMQ_USER/PASS)
  # strip_path:true strips /mq-admin so RabbitMQ receives requests at /
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
        methods:        [GET, POST, PUT, DELETE, OPTIONS]
