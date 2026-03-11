# CO3404 Distributed Systems — Video Demonstration Script
**Student:** Abeykoonge Vishani Nimeka | **ID:** 3000681 | **UCL Sri Lanka**
**Module:** CO3404 Distributed Systems | **Option 4**
**Target Duration:** 13–14 minutes

---

## PRE-RECORDING CHECKLIST

Complete every item below **before** pressing Record.

### Terminal commands to run first

```bash
# 1. Start the full local stack
cd /path/to/co3404-distributed-joke-system
docker compose up -d

# 2. Wait about 30 seconds, then verify all containers are healthy
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

# 3. Confirm RabbitMQ management UI is reachable
open http://localhost:15672          # user: guest / pass: guest

# 4. Confirm Kong is routing (should return types array)
curl -s http://localhost:8000/types

# 5. Confirm the Joke Machine frontend loads
open http://localhost:8000/joke-ui

# 6. Confirm the Submit frontend loads
open http://localhost:8000/submit

# 7. Confirm the Moderate frontend loads
open http://localhost:8000/moderate-ui
```

### Browser tabs to open in advance (in this order)

| Tab # | URL | Label |
|-------|-----|-------|
| 1 | `http://localhost:8000/joke-ui` | Joke Machine |
| 2 | `http://localhost:8000/submit` | Submit a Joke |
| 3 | `http://localhost:15672` | RabbitMQ |
| 4 | `http://localhost:8000/moderate-ui` | Moderator |
| 5 | Terminal window | Docker / Logs |

### Things to check before recording

- [ ] All Docker containers show `healthy` or `running`
- [ ] RabbitMQ shows 0 messages in all queues (clean state)
- [ ] Joke Machine loads and shows jokes
- [ ] Submit form shows joke type dropdown (ECST cache working)
- [ ] Auth0 login works on the Moderate page (`http://localhost:8000/moderate-ui`)
- [ ] `docker logs jokes_etl_service -f` is open and scrolling in a terminal
- [ ] Screen resolution is at least 1080p
- [ ] Microphone is working
- [ ] Notifications are turned off (Do Not Disturb mode on)

---

## THE SCRIPT

---

### SECTION 1 — Introduction
**Timestamp:** 0:00 – 1:00 | **Duration:** ~1 minute

**Screen to show:**
- Architecture diagram image (or draw it on a whiteboard/slides)
- Optionally show the project folder in VS Code

---

**Say this:**

> "Hello, my name is Vishani Nimeka, and I'm a Software Engineering student at UCL Sri Lanka. My student ID is 3000681. This video is my demonstration for the CO3404 Distributed Systems assignment, Option 4.
>
> In this project I built a distributed joke service using microservices. The system lets users browse jokes, submit new jokes, and have those jokes reviewed by a moderator before they go into the database.
>
> The architecture looks like this — [*point to diagram*] — a user sends a request to Kong, our API gateway. Kong routes it to the right service. When someone submits a joke, it goes into a RabbitMQ message queue, then a moderator reviews it, and only after approval does it get written to the database by the ETL service.
>
> There are four microservices in total: the Joke service, the Submit service, the Moderate service, and the ETL service. They run in Docker containers on Azure virtual machines, and I'll be demonstrating everything locally today.
>
> Let's get started."

---

### SECTION 2 — Show Running Services
**Timestamp:** 1:00 – 2:00 | **Duration:** ~1 minute

**Screen to show:**
- Terminal with `docker ps` output
- All containers listed as healthy/running

---

**Say this:**

> "First, let me show you that all the services are running. I'll switch to my terminal."
>
> *[Switch to terminal. Run:]*
> ```bash
> docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
> ```
>
> "You can see all the containers here. We have the **joke-service**, the **submit-service**, the **moderate-service**, and the **etl-service** — those are our four microservices. We also have **RabbitMQ** as the message broker, and **MySQL** as the database. Each one is running in its own isolated Docker container.
>
> This is what microservices architecture looks like in practice — instead of one big application, we have small, independent services that each do one specific job. If one of them crashes, the others keep running.
>
> Let me also quickly confirm RabbitMQ is up."
>
> *[Run:]*
> ```bash
> curl -s http://localhost:15672/api/overview -u guest:guest | python3 -c "import sys,json; d=json.load(sys.stdin); print('RabbitMQ', d['rabbitmq_version'])"
> ```
>
> "Perfect — RabbitMQ is running. Now let me show the actual application."

---

### SECTION 3 — Demonstrate Joke Service
**Timestamp:** 2:00 – 3:30 | **Duration:** ~1.5 minutes

**Screen to show:**
- Tab 1: `http://localhost:8000/joke-ui`
- Show the dropdown, click Get Joke, wait 3 seconds for punchline

---

**Say this:**

> "This is the Joke Machine — the public-facing frontend. It's served through Kong at the path `/joke-ui`. Let me pick a joke type from the dropdown."
>
> *[Click the type dropdown, select any category, e.g. "programming"]*
>
> "I'll select 'programming' and click Get Joke."
>
> *[Click the button. The setup line appears.]*
>
> "The setup appears immediately — notice the punchline hasn't shown yet. The frontend is deliberately waiting three seconds before revealing it. This is intentional — it gives the joke a better effect. [*pause 3 seconds*] And there's the punchline."
>
> "This joke was retrieved from the MySQL database through the Joke microservice. The request went through Kong's API gateway first, which added a rate limit and a correlation ID header. Let me prove the request went through Kong by opening the browser developer tools."
>
> *[Open DevTools → Network tab → click the joke request → show the `Kong-Request-ID` header]*
>
> "See this header — `Kong-Request-ID`. Kong added this automatically to every response. It proves the request was routed through the gateway. Now let me show how a new joke gets into the system."

---

### SECTION 4 — Demonstrate Submit Service
**Timestamp:** 3:30 – 5:00 | **Duration:** ~1.5 minutes

**Screen to show:**
- Tab 2: `http://localhost:8000/submit-ui`
- Fill in the form and click Submit

---

**Say this:**

> "This is the Submit page. I'll type a new joke and send it through the system. Let me put in the setup and punchline."
>
> *[Type something like:]*
> - Setup: `Why do programmers prefer dark mode?`
> - Punchline: `Because light attracts bugs.`
> - Type: select `programming` from the dropdown
>
> "Notice the joke type dropdown is already populated — that's because of a pattern called Event-Carried State Transfer, which I'll explain in a moment. The Submit service keeps a local copy of all known types, so it doesn't need to ask the Joke service every time.
>
> I'll click Submit now."
>
> *[Click Submit. A success message should appear — "Your joke has been submitted for review."]*
>
> "The page confirmed submission. The joke has been sent to a RabbitMQ message queue. It has NOT gone into the database yet — it's waiting for a moderator to review it. Let me open RabbitMQ and show you."

---

### SECTION 5 — Show RabbitMQ Submit Queue
**Timestamp:** 5:00 – 6:00 | **Duration:** ~1 minute

**Screen to show:**
- Tab 3: `http://localhost:15672`
- Log in as guest/guest
- Navigate to Queues → `submit` queue → show message count = 1

---

**Say this:**

> "I'm on the RabbitMQ management console. I'll go to the Queues tab."
>
> *[Click Queues]*
>
> "You can see two queues here — `submit` and `moderated`. Look at the `submit` queue — it shows 1 message ready. That's the joke I just submitted. It's sitting here waiting for a moderator to pick it up.
>
> This is why message queues are powerful in distributed systems. The Submit service has already finished its job and returned a response to the user. The joke is now safely stored in RabbitMQ. Even if the Moderate service was down, this message would stay here until the moderator comes back online. Nothing is lost.
>
> Let me now open the Moderate service and review this joke."

---

### SECTION 6 — Demonstrate Authentication and Moderate Service
**Timestamp:** 6:00 – 8:00 | **Duration:** ~2 minutes

**Screen to show:**
- Tab 4: `http://localhost:8000/moderate-ui`
- Auth0 login redirect
- Moderator dashboard with the joke waiting
- Approve the joke

---

**Say this:**

> "I'll open the Moderator page now."
>
> *[Switch to the Moderate tab. If not logged in, you'll see either a login prompt or an Auth0 redirect.]*
>
> "Notice I was automatically redirected to Auth0 to log in. This is the authentication step — the moderator must prove who they are before they can approve or reject jokes. This uses OpenID Connect, which is the industry standard for delegating authentication to a trusted identity provider. I don't have to manage passwords or user accounts in my own code — Auth0 handles all of that.
>
> Let me log in."
>
> *[Log in with your Auth0 credentials]*
>
> "I'm now authenticated. The system knows who I am — it extracted my email from the Auth0 token. Let me click to fetch the next joke for review."
>
> *[Click "Get Next Joke" or whatever button fetches the pending joke]*
>
> "There it is — the joke I just submitted: 'Why do programmers prefer dark mode?' — 'Because light attracts bugs.' I can approve it or reject it. I'm happy with it, so I'll click Approve."
>
> *[Click Approve]*
>
> "The moderator UI confirmed the joke was approved. Internally, what just happened is: the Moderate service took the message from the `submit` queue, attached my email address as `moderatedBy` — so there's an audit trail of who approved it — and published it to the `moderated` queue. Let me go back to RabbitMQ to verify."

---

### SECTION 7 — Show Moderated Queue
**Timestamp:** 8:00 – 9:00 | **Duration:** ~1 minute

**Screen to show:**
- RabbitMQ tab
- Switch to `moderated` queue — shows 1 message

---

**Say this:**

> "Back in RabbitMQ — I'll check the queues again."
>
> *[Refresh the Queues page]*
>
> "The `submit` queue is now empty — that message has been consumed. But the `moderated` queue now has 1 message. That's the approved joke, sitting here waiting for the ETL service to pick it up and write it to the database.
>
> This two-stage queue design is important. It means the only path for a joke to reach the database is through human review. The ETL service reads exclusively from the `moderated` queue — it never touches the `submit` queue. So an unreviewed joke literally cannot get into the database. That's an architecture-level guarantee, not just an application check.
>
> Let me switch to the terminal and watch the ETL service consume it."

---

### SECTION 8 — Demonstrate ETL Service
**Timestamp:** 9:00 – 10:00 | **Duration:** ~1 minute

**Screen to show:**
- Terminal running `docker logs etl-service -f`
- Watch the log line appear confirming the joke was written to the database

---

**Say this:**

> "I have the ETL service logs open here. I'll watch it in real time."
>
> *[Run:]*
> ```bash
> docker logs jokes_etl_service --tail=20 -f
> ```
>
> "The ETL — Extract, Transform, Load — service is a headless consumer. It runs in the background, there's no user interface. It just watches the `moderated` queue and writes anything it finds to the database.
>
> [*point to log line*] You can see a log line confirming it picked up the message and wrote the joke to MySQL. Notice it says 'ack' — that means RabbitMQ was told the message was successfully processed and can be removed from the queue. This is important: the ETL only sends that acknowledgment *after* the database write succeeds. If the database was temporarily unavailable, the ETL would nack the message and RabbitMQ would redeliver it automatically.
>
> Now let me go to the database and verify the joke is actually there."

---

### SECTION 9 — Demonstrate Database
**Timestamp:** 10:00 – 11:00 | **Duration:** ~1 minute

**Screen to show:**
- MySQL query result showing the new joke in the `jokes` table
- Either use a database GUI (TablePlus, DBeaver) or terminal

---

**Say this:**

> "Let me query the database directly to confirm."
>
> *[Run:]*
> ```bash
> docker exec -it jokes_mysql mysql -u root -prootpassword jokesdb \
>   -e "SELECT j.id, j.setup, j.punchline, t.name AS type FROM jokes j JOIN types t ON j.type_id = t.id ORDER BY j.id DESC LIMIT 3;"
> ```
>
> "There it is — 'Why do programmers prefer dark mode?' and 'Because light attracts bugs.' — the joke I submitted a few minutes ago is now in the database, linked to the `programming` type.
>
> The full journey was: Submit form → RabbitMQ `submit` queue → Moderate service reviewed it → RabbitMQ `moderated` queue → ETL service → MySQL database → now visible in the Joke Machine.
>
> Speaking of the Joke Machine — let me go back and request a joke from the programming category to confirm it appears."
>
> *[Switch to Joke Machine tab, select programming, click Get Joke a couple of times until the new one appears — or just note it's now in the pool]*
>
> "It's now in the pool of available jokes."

---

### SECTION 10 — Demonstrate MySQL and MongoDB Switching
**Timestamp:** 11:00 – 12:00 | **Duration:** ~1 minute

**Screen to show:**
- Terminal showing the `DB_TYPE` environment variable
- Show the Docker Compose profile command
- Briefly show a joke being retrieved after the switch

---

**Say this:**

> "One of the Option 4 features is support for two databases — MySQL and MongoDB — switchable at runtime using an environment variable called `DB_TYPE`. Let me show you how this works.
>
> Currently the system is running with MySQL. The environment variable is set to `mysql`. If I change it to `mongo` and use the Mongo Docker Compose profile, the exact same application code connects to MongoDB instead. Watch."
>
> *[Run:]*
> ```bash
> docker compose down
> DB_TYPE=mongo docker compose --profile mongo up -d
> ```
>
> *[Wait for startup — about 30 seconds. The MongoDB healthcheck must pass.]*
>
> *[Open the Joke Machine and request a joke]*
>
> "Same frontend, same API, same Kong gateway — but now the jokes are being read from and written to MongoDB instead of MySQL. No application code changed — just the environment variable. This design pattern is called an adapter: the database adapter provides the same function names to the rest of the application, so the rest of the code doesn't know or care which database is running underneath.
>
> I'll switch back to MySQL for the rest of the demo."
>
> ```bash
> docker compose down && docker compose up -d
> ```

---

### SECTION 11 — Demonstrate Kong API Gateway
**Timestamp:** 12:00 – 13:00 | **Duration:** ~1 minute

**Screen to show:**
- Terminal with `curl` commands showing rate limiting and correlation ID
- Browser showing HTTPS (if using Kong with TLS locally)

---

**Say this:**

> "Let me demonstrate the Kong API gateway features specifically. Kong sits in front of all the services — nothing is reachable without going through Kong.
>
> First, the correlation ID. Every response has a `Kong-Request-ID` header added automatically."
>
> *[Run:]*
> ```bash
> curl -si http://localhost:8000/joke/any | grep -i kong-request
> ```
>
> "You can see the header there. This is useful for debugging — if something goes wrong, you can trace a specific request through all the logs using this ID.
>
> Now let me demonstrate rate limiting. The Joke API is limited to 5 requests per minute per IP address."
>
> *[Run:]*
> ```bash
> for i in 1 2 3 4 5 6; do
>   echo -n "Request $i: "
>   curl -s -o /dev/null -w "%{http_code}" http://localhost:8000/joke/any
>   echo
> done
> ```
>
> "Requests 1 to 5 return 200 — success. Request 6 returns 429 — Too Many Requests. Kong blocked it automatically, no application code needed. In production this rate limit protects the backend from being overwhelmed by scrapers or accidental infinite loops in a client application."

---

### SECTION 12 — Demonstrate System Resilience
**Timestamp:** 13:00 – 14:00 | **Duration:** ~1 minute

**Screen to show:**
- Terminal stopping the joke service
- Submit form still working
- RabbitMQ queue still accumulating messages
- Joke service restarted and everything recovers

---

**Say this:**

> "Finally, let me show that the system is resilient to individual service failures. I'll stop the Joke service completely."
>
> *[Run:]*
> ```bash
> docker stop jokes_joke_service
> ```
>
> "The Joke Machine will now be unavailable — that's expected. But let me check: can I still submit a joke?"
>
> *[Switch to the Submit tab, submit another joke]*
>
> "Yes — the Submit service is completely independent of the Joke service. It published the message to RabbitMQ as normal. The message is sitting in the queue waiting for a moderator. The Joke service being down has no effect on the submit pipeline at all.
>
> This is the key benefit of the microservices architecture: fault isolation. In a monolith, if one feature crashed, the whole application would go down. Here, the read path failed but the write path continued working perfectly.
>
> Let me bring the Joke service back."
>
> *[Run:]*
> ```bash
> docker start jokes_joke_service
> ```
>
> *[Wait a few seconds, then reload the Joke Machine]*
>
> "It recovered automatically — no manual intervention, just a `docker start`. The `restart: unless-stopped` Docker policy handles this in production automatically."

---

### SECTION 13 — Conclusion
**Timestamp:** 14:00 – 14:30 | **Duration:** ~30 seconds

**Screen to show:**
- Optionally show the architecture diagram again
- Or just face the camera

---

**Say this:**

> "That completes my demonstration of the CO3404 Option 4 distributed joke service.
>
> To summarise what I've shown: four independent microservices communicating through RabbitMQ, with a human moderation gate enforced at the infrastructure level; Auth0 OpenID Connect protecting the moderator interface; Kong API gateway providing rate limiting, TLS, and correlation IDs; MySQL and MongoDB as switchable database backends; and Docker containers with a GitHub Actions CI/CD pipeline for automated deployment.
>
> Thank you for watching. I'm Vishani Nimeka, student ID 3000681, CO3404 Distributed Systems."

---

## FINAL REQUIREMENTS CHECKLIST

Use this after recording to confirm every marking criterion was demonstrated.

| # | Requirement | Demonstrated In | ✓ |
|---|------------|-----------------|---|
| 1 | Joke Service — retrieve joke by type | Section 3 | ☐ |
| 2 | Joke Service — random joke | Section 3 | ☐ |
| 3 | Submit Service — POST /submit returns 202 | Section 4 | ☐ |
| 4 | Submit form shows joke types (ECST cache) | Section 4 | ☐ |
| 5 | RabbitMQ `submit` queue receives message | Section 5 | ☐ |
| 6 | Moderate Service — fetch joke from queue | Section 6 | ☐ |
| 7 | Moderate Service — approve joke | Section 6 | ☐ |
| 8 | Auth0 OIDC login required for moderation | Section 6 | ☐ |
| 9 | RabbitMQ `moderated` queue receives approved joke | Section 7 | ☐ |
| 10 | ETL Service — consumes queue, writes to DB | Section 8 | ☐ |
| 11 | ETL logs show ack after successful write | Section 8 | ☐ |
| 12 | Database shows new joke in table | Section 9 | ☐ |
| 13 | MongoDB switching via DB_TYPE env var | Section 10 | ☐ |
| 14 | Kong `Kong-Request-ID` correlation header | Section 11 | ☐ |
| 15 | Kong rate limiting — 429 on request 6 | Section 11 | ☐ |
| 16 | Service failure — other services unaffected | Section 12 | ☐ |
| 17 | Automatic recovery after service restart | Section 12 | ☐ |
| 18 | Docker containers shown running | Section 2 | ☐ |
| 19 | All containers healthy | Section 2 | ☐ |

---

## TIMING SUMMARY

| Section | Title | Time |
|---------|-------|------|
| 1 | Introduction | 0:00 – 1:00 |
| 2 | Running Services | 1:00 – 2:00 |
| 3 | Joke Service | 2:00 – 3:30 |
| 4 | Submit Service | 3:30 – 5:00 |
| 5 | RabbitMQ Submit Queue | 5:00 – 6:00 |
| 6 | Authentication + Moderate | 6:00 – 8:00 |
| 7 | Moderated Queue | 8:00 – 9:00 |
| 8 | ETL Service | 9:00 – 10:00 |
| 9 | Database | 10:00 – 11:00 |
| 10 | MySQL / MongoDB Switching | 11:00 – 12:00 |
| 11 | Kong API Gateway | 12:00 – 13:00 |
| 12 | System Resilience | 13:00 – 14:00 |
| 13 | Conclusion | 14:00 – 14:30 |
| **Total** | | **~14 minutes 30 seconds** |

> **Tip:** Speak at a calm, steady pace. If you finish early, pause briefly rather than rushing the next section. If you're running over time, you can skip the MongoDB switching demo (Section 10) and still satisfy all core Option 4 requirements — just mention it verbally.
