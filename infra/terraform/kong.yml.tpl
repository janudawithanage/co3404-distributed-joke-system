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
  # Joke Service — VM1 (${vm1_private_ip}:3001)
  #
  # Route:  /joke  (prefix, strip_path=false)
  #   Kong receives:   GET /joke/programming
  #   Forwards to:     GET http://${vm1_private_ip}:3001/joke/programming
  #
  # Rate limiting: ${rate_limit_per_minute} requests/minute per client IP.
  # Demonstrating that a downstream service can be protected by Kong
  # without modifying the service itself.
  # ---------------------------------------------------------------------------
  - name: joke-service
    url:              http://${vm1_private_ip}:3001
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
          policy:         local          # "local" = per Kong node, fine for single-VM demo
          error_code:     429
          error_message:  "Rate limit exceeded — Joke API allows ${rate_limit_per_minute} req/min. Retry after 60 seconds."
          hide_client_headers: false    # expose X-RateLimit-Remaining-Minute header

  # ---------------------------------------------------------------------------
  # Submit Service — VM2 (${vm2_private_ip}:3002)
  #
  # Route:  /submit  (prefix, strip_path=false)
  #   Kong receives:   POST /submit
  #   Forwards to:     POST http://${vm2_private_ip}:3002/submit
  #
  # No rate limiting on submit — demonstrates per-service plugin configuration.
  # ---------------------------------------------------------------------------
  - name: submit-service
    url:              http://${vm2_private_ip}:3002
    connect_timeout:  5000
    read_timeout:     10000
    write_timeout:    10000
    retries:          3

    routes:
      - name:           submit-route
        paths:          [/submit]
        strip_path:     false
        preserve_host:  false
        methods:        [GET, POST, OPTIONS]
