# ADR 0302 — Same-origin API through a CloudFront VPC origin to an internal ALB

- Status: Accepted (prerequisites to be verified with the platform team)

## Context

The SPA calls the API at relative `/v1/...`. Serving both from one CloudFront
distribution avoids CORS, keeps cookies/headers same-origin and lets the platform-managed
WAF protect both. The API must not be directly reachable from the internet.

## Decision

- CloudFront default behaviour → private S3 bucket via **Origin Access Control**;
  SPA routing via a viewer-request CloudFront Function attached to the default
  behaviour only (no global custom error responses, which would turn API 403/404
  into `index.html`).
- Behaviour `/v1/*` → **CloudFront VPC origin** pointing at an **internal** ALB in
  the app subnets: HTTPS only, TLS 1.2, caching disabled, all viewer headers
  except `Host` forwarded (the origin name matches the ALB certificate).
- The ALB security group admits only the CloudFront origin-facing managed prefix
  list on 443; the ALB has a single HTTPS listener.

## Alternatives considered

- Internet-facing ALB + prefix list + secret origin header: requires public
  subnets in the workload VPC and exposes an internet endpoint; kept as the
  documented fallback.
- API Gateway HTTP API + VPC link: another edge, another auth/CORS surface;
  no benefit for this API.

## Consequences

- AWS requires an internet gateway attached to the VPC for VPC origins (traffic
  does not use it) — must be confirmed for landing-zone VPCs (landing-zone-adaptation.md §4).
- The SG model (prefix list vs. `CloudFront-VPCOrigins-Service-SG`) and the
  prefix-list ID are assumptions to verify.
