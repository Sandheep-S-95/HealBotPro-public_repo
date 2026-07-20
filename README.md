# HealBot Pro v2 — Conversational Medical AI

**🚀 Live Demo:** [https://heal-bot-pro-sigma.vercel.app/](https://heal-bot-pro-sigma.vercel.app/)

> **What changed from v1:** The static textarea has been replaced with a multi-turn
> conversational intake assistant (MediAssist) that asks clarifying questions before
> triggering the diagnostic pipeline. Everything else — Neo4j, Pinecone, Groq — is
> preserved and improved.

---

## Architecture

```
Patient → Chat UI (IntakeChat)
              ↓  POST /intake/turn  (repeat 4-6 times)
         MediAssist (Groq · LLaMA-3 70B)
              ↓  [INTAKE_COMPLETE] detected
         POST /consult
              ↓
   Step 1: extract_symptoms_with_llm      (Groq · llama-3.1-8b-instant)
   Step 2: pass_1_neo4j_graph_search      (Neo4j AuraDB)
   Step 3: pass_2_pinecone_rag_retrieval  (Pinecone + all-MiniLM-L6-v2)
   Step 4: generate_consultation_report   (Groq · llama-3.3-70b-versatile)
              ↓
         Doctor's Consultation Brief → Report UI
```

---

## Quick Start

### 1. Clone and set up backend

```bash
git clone <your-repo>
cd healbot-pro

# Create virtual environment
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt

# Configure environment
cp .env.example .env
# → Open .env and fill in your API keys (see below)

# Start backend
python main.py
# or: uvicorn main:app --host 0.0.0.0 --port 8002 --reload
```

### 2. Set up frontend

```bash
cd frontend

# Install Node dependencies
npm install

# Configure API URL
cp .env.example .env
# The default VITE_API_BASE=http://localhost:8002 is correct for local dev

# Start dev server
npm run dev
# → Open http://localhost:5173
```

---

## Environment Variables

Copy `.env.example` → `.env` in the **project root** and fill in:

| Variable | Where to get it |
|---|---|---|
| `GROQ_API_KEY` | [console.groq.com](https://console.groq.com) |
| `PINECONE_API_KEY` | [app.pinecone.io](https://app.pinecone.io) |
| `PINECONE_INDEX` | Your index name (dimension=384, cosine) | 
| `NEO4J_URI` | [console.neo4j.io](https://console.neo4j.io) (AuraDB Free) | 
| `NEO4J_USER` | AuraDB dashboard |
| `NEO4J_PASSWORD` | AuraDB dashboard |
| `DATABASE_URL` | Leave as default for SQLite |
| `PORT` | Defaults to `8002` |

---

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET`  | `/` | Health check |
| `POST` | `/register` | Create patient account |
| `POST` | `/login` | Login (returns Bearer token) |
| `GET`  | `/users/me` | Get current user |
| `POST` | `/intake/turn` | **[NEW]** One conversational intake turn |
| `POST` | `/consult` | Run full diagnostic pipeline |
| `POST` | `/upload` | Upload medical PDF |
| `POST` | `/user/history` | Encode history to Pinecone |
| `GET`  | `/user/{id}` | Check patient status |

### `/intake/turn` request format

```json
{
  "conversation": [
    {"role": "user", "content": "I have a headache and fever"},
    {"role": "assistant", "content": "How long have you had these symptoms?"}
  ],
  "doc_path": null
}
```

### `/consult` request format

```json
{
  "patient_summary": "Patient reports 3-day headache, fever 38.5°C, nausea...",
  "user_id": "john_doe",
  "doc_path": "temp_uploads/abc123.pdf",
  "conversation_transcript": "Patient: I have a headache...\nMediAssist: ..."
}
```

---

## File Structure

```
healbot-pro/
├── main.py              ← FastAPI app (all endpoints)
├── inference.py         ← AI pipeline (Groq, Neo4j, Pinecone)
├── db.py                ← SQLite/SQLModel database
├── requirements.txt
├── .env.example         ← Copy to .env
├── .gitignore
└── frontend/
    ├── src/
    │   ├── App.jsx              ← App orchestrator, Landing page
    │   ├── index.css            ← Global styles
    │   ├── main.jsx
    │   └── components/
    │       ├── Auth.jsx         ← Login / Register
    │       ├── IntakeChat.jsx   ← Conversational symptom intake (NEW)
    │       ├── ReportView.jsx   ← Report display
    │       └── HistoryModal.jsx ← Encode medical history
    ├── index.html
    ├── package.json
    ├── vite.config.js
    └── .env.example
```

---

## How the Conversational Intake Works

1. **Patient logs in** → sent to `IntakeChat`
2. **MediAssist greets** them and asks about their chief complaint
3. **Patient replies** → `POST /intake/turn` with full conversation history
4. **LLaMA-3 70B** (as MediAssist) asks ONE targeted follow-up question per turn, probing: onset, duration, severity, associated symptoms, aggravating/relieving factors, medications, allergies
5. After 4-7 turns, when enough info is gathered, the model outputs `[INTAKE_COMPLETE]` with a JSON summary
6. Frontend detects this → shows pipeline animation overlay
7. `POST /consult` is called with the summary → full 4-step pipeline runs
8. Doctor's report is displayed

---

## What Was Removed From v1

- `check_db_schema.py` — dev utility, not needed
- `dataset_loader_script.py` — one-time script
- `generate_cypher.py` — one-time script  
- `generate_graph.py` — one-time script
- `mock_user_data.py` — test data
- `smoke_test.py` — test script
- `split_dataset.py` — one-time script
- `test_db.py` — test script
- `test_signup.py` — test script
- `test_simplified_auth.py` — test script
- `test_status_check.py` — test script
- `*.html` standalone demo files
- `notes.txt`

---

## LLM Models Used (All Free via Groq)

| Task | Model | Notes |
|---|---|---|
| Conversational intake | `llama-3.3-70b-versatile` | Best reasoning for medical Q&A |
| Symptom extraction | `llama-3.1-8b-instant` | Fast, lightweight |
| Report generation | `llama-3.3-70b-versatile` | Best for structured clinical writing |

All models are available on Groq's **free tier** with generous rate limits.
