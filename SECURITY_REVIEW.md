# Security Review — Specialization Explorer

> Generated: 2026-05-05
> Tools: Semgrep, Bandit, Checkov, Manual Review
> Risk Level: 🟡 MEDIUM
> Total Findings: 24

---

## Executive Summary

No critical or high severity vulnerabilities were found. The codebase follows good security practices overall — parameterized queries are used throughout, secrets are managed via AWS Secrets Manager, admin authorization is enforced at the handler level, and input validation is consistent. The most impactful issues are TLS verification being disabled on all database connections (8 files, same one-line fix each), and the container image running as root.

---

## Scan Coverage

| Tool | Scope | Findings |
|------|-------|----------|
| Semgrep | JS, TS, Python, Dockerfile | 12 |
| Bandit | Python | 2 |
| Checkov | Dockerfile, OpenAPI spec | 6 |
| Manual Review | Auth, secrets, logging patterns | 4 |
| **Total** | | **24** |

---

## Findings

### 🔴 High Priority

---

#### SEC-001 — TLS Verification Disabled on All Database Connections

- **Severity:** High
- **CWE:** CWE-319 — Cleartext Transmission of Sensitive Information
- **OWASP:** A03:2017 — Sensitive Data Exposure
- **Tool:** Semgrep
- **Files affected (8):**
  - `cdk/lambda/authorization/initializeConnection.js:28`
  - `cdk/lambda/db_setup/index.js:36, 63`
  - `cdk/lambda/handlers/adminHandler.js:38`
  - `cdk/lambda/handlers/chatSessionHandler.js:27`
  - `cdk/lambda/handlers/initializeConnection.js:28`
  - `cdk/lambda/handlers/systemMessagesHandler.js:27`
  - `cdk/lambda/handlers/userHandler.js:27`

**Description:**
Every Node.js Lambda that connects to RDS sets `ssl: { rejectUnauthorized: false }`, which disables TLS certificate validation. This makes the connection vulnerable to man-in-the-middle attacks. While the practical risk is reduced because the database is behind RDS Proxy inside a private VPC subnet, the configuration is still incorrect and should be fixed.

**Current code (all affected files):**
```javascript
ssl: { rejectUnauthorized: false }
```

**Recommended fix:**
Set `rejectUnauthorized: true` and supply the RDS CA certificate. AWS provides a CA bundle for RDS at `https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem`. The bundle can be bundled with the Lambda deployment package or fetched at cold start.

```javascript
const fs = require("fs");
const path = require("path");

// Bundle global-bundle.pem with the Lambda package
const ca = fs.readFileSync(path.join(__dirname, "global-bundle.pem"));

ssl: {
  rejectUnauthorized: true,
  ca,
}
```

Alternatively, for RDS Proxy specifically, you can rely on the proxy's own TLS termination and set `rejectUnauthorized: true` without a custom CA if the proxy endpoint uses a publicly trusted certificate.

---

#### SEC-002 — Dockerfile Runs as Root

- **Severity:** High
- **CWE:** CWE-250 — Execution with Unnecessary Privileges
- **OWASP:** A04:2021 — Insecure Design
- **Tool:** Semgrep (ERROR), Checkov (CKV_DOCKER_3)
- **File:** `cdk/lambda/vectorIndexManagerSigV4/Dockerfile`

**Description:**
The Dockerfile has no `USER` directive, so the container process runs as root. If the container is compromised, an attacker has root-level access to the container filesystem and any mounted resources.

**Current Dockerfile:**
```dockerfile
FROM public.ecr.aws/lambda/python:3.12

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt -t ${LAMBDA_TASK_ROOT}

COPY main.py ${LAMBDA_TASK_ROOT}/

CMD ["main.handler"]
```

**Recommended fix:**
Add a non-root user. Note that AWS Lambda base images run the function handler as a specific UID internally — check whether the base image already enforces this. If not, add:

```dockerfile
FROM public.ecr.aws/lambda/python:3.12

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt -t ${LAMBDA_TASK_ROOT}

COPY main.py ${LAMBDA_TASK_ROOT}/

# Run as non-root user
RUN useradd -m appuser
USER appuser

CMD ["main.handler"]
```

---

### 🟡 Medium Priority

---

#### SEC-003 — Database Credentials Logged on Connection Failure

- **Severity:** Medium
- **CWE:** CWE-532 — Insertion of Sensitive Information into Log File
- **Tool:** Manual Review
- **File:** `cdk/lambda/authorization/initializeConnection.js:40`

**Description:**
The catch block in `initializeConnection.js` logs `host`, `username`, and `database` when a connection fails. These values end up in CloudWatch Logs and could expose infrastructure details or credential metadata to anyone with log access.

**Current code:**
```javascript
} catch (error) {
  console.error("Error initializing database connection:", error);
  console.error("Connection details:", {
    host: RDS_PROXY_ENDPOINT,
    username: credentials?.username,   // ⚠️ logged to CloudWatch
    database: credentials?.dbname,     // ⚠️ logged to CloudWatch
  });
  throw new Error(`Failed to initialize database connection: ${error.message}`);
}
```

**Recommended fix:**
Log only the error message, not connection parameters:
```javascript
} catch (error) {
  console.error("Error initializing database connection:", error.message);
  throw new Error(`Failed to initialize database connection: ${error.message}`);
}
```

---

#### SEC-004 — JWT Secret Cached Without Rotation Awareness

- **Severity:** Medium
- **Tool:** Manual Review
- **Files:**
  - `cdk/lambda/authorization/userAuthorizerFunction.js:8`
  - `cdk/lambda/publicTokenFunction/publicTokenFunction.js:9`

**Description:**
Both functions cache the JWT secret in the Lambda global scope (`let cachedSecret`). If the secret is rotated in AWS Secrets Manager, the Lambda execution environment will continue using the stale secret until the environment is recycled (which can take hours on a warm function). During that window, tokens signed with the new secret will be rejected, and tokens signed with the old secret will still be accepted.

**Current code:**
```javascript
let cachedSecret; // module-level, never expires

exports.handler = async (event) => {
  if (!cachedSecret) {
    // fetched once, never refreshed
    cachedSecret = JSON.parse(response.SecretString).jwtSecret;
  }
  ...
};
```

**Recommended fix:**
Add a TTL to the cache so it refreshes periodically. Use AWS Lambda Powertools `parameters` utility (already used in the Python Lambdas) or implement a simple timestamp-based expiry:

```javascript
let cachedSecret;
let cacheExpiry = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

exports.handler = async (event) => {
  if (!cachedSecret || Date.now() > cacheExpiry) {
    const response = await secretsManager.send(
      new GetSecretValueCommand({ SecretId: process.env.JWT_SECRET })
    );
    cachedSecret = JSON.parse(response.SecretString).jwtSecret;
    cacheExpiry = Date.now() + CACHE_TTL_MS;
  }
  ...
};
```

---

#### SEC-005 — OpenAPI Spec Missing Global Security Definition

- **Severity:** Medium
- **Tool:** Checkov (CKV_OPENAPI_4, CKV_OPENAPI_5, CKV_OPENAPI_20)
- **File:** `cdk/OpenAPI_Swagger_Definition.yaml`

**Description:**
The OpenAPI spec has no top-level `security` field and some operations do not declare security requirements. Checkov also flags that the `apiKey` scheme definition does not enforce HTTPS-only transport (CKV_OPENAPI_20). The actual API Gateway enforces authentication via Lambda authorizers at runtime, so there is no exploitable gap — but the spec does not accurately document the security model, which can mislead consumers and automated tooling.

**Recommended fix:**
Add a global `security` block referencing the defined authorizers, and add `servers` with an HTTPS scheme:

```yaml
servers:
  - url: https://{apiId}.execute-api.{region}.amazonaws.com/prod

security:
  - userAuthorizer: []

# Override per-endpoint for public routes:
paths:
  /user/publicToken:
    get:
      security: []  # explicitly unsecured
```

Also add `maxItems` constraints to array fields to address CKV_OPENAPI_21 and reduce DoS surface:
```yaml
include_patterns:
  type: array
  maxItems: 50
  items:
    type: string
```

---

### 🟢 Low Priority / Informational

---

#### SEC-006 — Bare `except: pass` Silently Swallows DB Cleanup Errors

- **Severity:** Low
- **Tool:** Bandit (B110)
- **File:** `cdk/lambda/textGeneration/helpers/db_connection.py:54`

**Description:**
A bare `except: pass` in the connection cleanup path silently discards any exception raised when closing a failed connection. This is not a security vulnerability but hides failures that could indicate a deeper problem.

**Current code:**
```python
try:
    connection.close()
except:
    pass
```

**Recommended fix:**
```python
try:
    connection.close()
except Exception as close_err:
    logger.warning(f"Failed to close DB connection during cleanup: {close_err}")
```

---

#### SEC-007 — Pseudo-Random Used for Backoff Jitter *(False Positive)*

- **Severity:** Low (false positive)
- **Tool:** Bandit (B311)
- **File:** `cdk/lambda/knowledgeBaseProvisioner/main.py:18`

**Description:**
Bandit flags `random.random()` as unsuitable for cryptographic use. In this case it is used only to add jitter to an exponential backoff delay — a non-security use case where `random` is entirely appropriate. No action required.

---

#### SEC-008 — Log Forging via String Concatenation in console.log *(Low Confidence)*

- **Severity:** Informational
- **CWE:** CWE-134 — Use of Externally-Controlled Format String
- **Tool:** Semgrep
- **Files:**
  - `cdk/lambda/ecrImageWaiter/index.js:127`
  - `frontend/src/pages/HomePage.tsx:126`

**Description:**
Semgrep flags string concatenation inside `console.log` calls as a potential log forging vector. Log forging is only a real concern when the concatenated value originates from untrusted user input. Review both locations to confirm the interpolated values are not user-controlled. If they are, sanitize newlines before logging (`value.replace(/[\r\n]/g, ' ')`).

---

#### SEC-009 — SQL String Interpolation in `createAppUsers` *(False Positive)*

- **Severity:** Informational (false positive)
- **Tool:** Semgrep
- **File:** `cdk/lambda/db_setup/index.js:109`

**Description:**
Semgrep flags template literal interpolation of `RW_NAME` and `TC_NAME` inside a SQL string. Both values are hardcoded constants (`"app_rw"` and `"app_tc"`) defined earlier in the same file — they are not user-controlled. The `dbIdent` variable is also sanitized with `replace(/"/g, '""')`. No injection risk exists. No action required.

---

## STRIDE Threat Model Summary

| Threat | Applicable | Finding |
|--------|-----------|---------|
| **Spoofing** | Yes | SEC-004 — stale JWT secret cache could allow tokens signed with old key to remain valid after rotation |
| **Tampering** | Low | Parameterized queries used throughout; no injection vectors found in application logic |
| **Repudiation** | Yes | SEC-003 — sensitive data in logs; audit trail completeness depends on CloudWatch retention settings |
| **Information Disclosure** | Yes | SEC-001 (TLS bypass), SEC-003 (credential logging) |
| **Denial of Service** | Low | SEC-005 — unbounded array inputs in OpenAPI spec; WAF + API Gateway throttling mitigates at infrastructure level |
| **Elevation of Privilege** | Yes | SEC-002 — container runs as root |

---

## Remediation Priority

| Priority | Finding | Effort |
|----------|---------|--------|
| 1 | SEC-001 — TLS bypass (8 files, same fix) | Low — one-line change per file |
| 2 | SEC-002 — Dockerfile root user | Low — add 2 lines to Dockerfile |
| 3 | SEC-003 — Credential logging | Low — remove 3 lines from catch block |
| 4 | SEC-004 — JWT cache TTL | Low — add timestamp expiry |
| 5 | SEC-005 — OpenAPI spec security fields | Medium — spec documentation update |
| 6 | SEC-006 — Bare except pass | Low — add log line |
| 7 | SEC-007 | No action — false positive |
| 8 | SEC-008 | Review only — confirm values are not user-controlled |
| 9 | SEC-009 | No action — false positive |

---

## What Was Not Scanned

- **Dependency CVEs** — Grype is not installed in this environment. Run `brew install grype && grype dir:.` to scan `package-lock.json`, `requirements.txt`, and other dependency manifests for known CVEs.
- **Container image CVEs** — The `public.ecr.aws/lambda/python:3.12` base image was not scanned. Run `trivy image public.ecr.aws/lambda/python:3.12` to check for OS-level vulnerabilities.
- **Secrets detection** — No secrets scanner (e.g., `detect-secrets`, `trufflehog`) was run. Recommended as a pre-commit hook.
- **Runtime behavior** — Static analysis only. Dynamic testing (e.g., DAST, penetration testing) was not performed.

---

*Scanned with [MCP Security Scanner](https://github.com/aws-samples/sample-mcp-security-scanner)*
