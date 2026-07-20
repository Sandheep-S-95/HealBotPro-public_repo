"""
HealBot Pro – Inference Pipeline
Handles: conversational symptom intake, Neo4j graph RAG, Pinecone vector RAG,
         and final report generation.
All LLM calls use Groq (free tier, no usage limit for hobby projects).
"""

import os
import json
import datetime
import uuid
import re
from groq import Groq
from neo4j import GraphDatabase
from pinecone import Pinecone
import httpx

# ─────────────────────────────────────────
# ENV LOADER
# ─────────────────────────────────────────
def _load_env():
    env_path = os.path.join(os.path.dirname(__file__), ".env")
    if os.path.exists(env_path):
        with open(env_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, val = line.split("=", 1)
                    os.environ.setdefault(key.strip(), val.strip().strip("'\""))

_load_env()

# ─────────────────────────────────────────
# CLIENTS
# ─────────────────────────────────────────
GROQ_API_KEY    = os.getenv("GROQ_API_KEY", "")
PINECONE_API_KEY = os.getenv("PINECONE_API_KEY", "")
NEO4J_URI       = os.getenv("NEO4J_URI", "")
NEO4J_USER      = os.getenv("NEO4J_USER", "neo4j")
NEO4J_PASSWORD  = os.getenv("NEO4J_PASSWORD", "")
PINECONE_INDEX  = os.getenv("PINECONE_INDEX", "medical-disease-rag")

groq_client = Groq(api_key=GROQ_API_KEY)

pc = Pinecone(api_key=PINECONE_API_KEY)
pinecone_index = pc.Index(PINECONE_INDEX)

neo4j_driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")

def get_embedding(text: str) -> list[float]:
    """Generates embeddings using Google Gemini API via HTTP.
    Lightweight, sure-shot, free, and produces 768-dimensional vectors."""
    url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent?key={GEMINI_API_KEY}"
    payload = {
        "model": "models/gemini-embedding-2",
        "outputDimensionality": 384,
        "content": {
            "parts": [{"text": text}]
        }
    }
    
    try:
        resp = httpx.post(url, json=payload)
        resp.raise_for_status()
        result = resp.json()
        return result["embedding"]["values"]
    except Exception as e:
        print(f"   [WARNING] [Network/API Error] Gemini API failed: {e}")
        return [0.0] * 384

# ─────────────────────────────────────────
# CONVERSATIONAL INTAKE
# ─────────────────────────────────────────

# The system prompt that drives the intake assistant.
INTAKE_SYSTEM_PROMPT = """You are MediAssist, a compassionate and professional AI medical intake assistant for HealBot Pro.
Your role is to have a warm, focused conversation with the patient to gather a complete clinical picture BEFORE passing
their information to the diagnostic pipeline.

GOALS per turn:
1. Ask ONE clear question at a time (never overwhelm the patient).
2. Probe for: chief complaint → duration/onset → severity (1-10) → associated symptoms → aggravating/relieving factors → relevant medical history → current medications → allergies.
3. Use plain language — avoid medical jargon unless the patient uses it first.
4. Show empathy, especially if the patient sounds anxious.
5. When you have gathered sufficient information (typically 4-7 turns), output the special marker:
   [INTAKE_COMPLETE]
   followed immediately by a JSON object on the same or next line:
   {"summary": "<2-3 sentence natural language summary of all gathered info>", "ready": true}

RULES:
- Never diagnose or speculate on conditions during intake.
- Never ask more than one question per message.
- Keep responses concise (2-4 sentences max during intake).
- If the patient gives an irrelevant answer, or answers a previously asked question instead of the current one, politely acknowledge it but RE-ASK the current question. Do NOT move on to the next question until you have received a satisfactory answer to your current question.
- If the patient seems to be in acute distress or mentions chest pain/difficulty breathing/stroke symptoms, immediately advise them to call emergency services (112/911) and mark intake complete.
- The JSON after [INTAKE_COMPLETE] must be valid JSON on its own line."""


def chat_intake_turn(conversation_history: list[dict]) -> dict:
    """
    Given the full conversation history (list of {role, content} dicts),
    returns the next assistant message.
    Also checks if intake is complete.

    Returns:
        {
          "message": str,           # assistant reply to show patient
          "intake_complete": bool,
          "summary": str | None     # filled when intake_complete=True
        }
    """
    response = groq_client.chat.completions.create(
        model="llama-3.3-70b-versatile",
        messages=[{"role": "system", "content": INTAKE_SYSTEM_PROMPT}] + conversation_history,
        temperature=0.4,
        max_tokens=512,
    )
    content = response.choices[0].message.content.strip()

    # Check for completion marker
    if "[INTAKE_COMPLETE]" in content:
        # Split on the marker
        parts = content.split("[INTAKE_COMPLETE]", 1)
        display_message = parts[0].strip()
        json_part = parts[1].strip()

        # Extract JSON robustly
        try:
            # Find first '{' and last '}'
            start = json_part.index("{")
            end = json_part.rindex("}") + 1
            parsed = json.loads(json_part[start:end])
            summary = parsed.get("summary", "Patient has described their symptoms.")
        except Exception:
            summary = "Patient has described their symptoms."

        # If no display message before the marker, use a friendly closing line
        if not display_message:
            display_message = (
                "Thank you for sharing all of that. I now have enough information to prepare "
                "your consultation report. Please hold on while the AI pipeline analyzes your case."
            )

        return {
            "message": display_message,
            "intake_complete": True,
            "summary": summary,
        }

    return {
        "message": content,
        "intake_complete": False,
        "summary": None,
    }



# ─────────────────────────────────────────
# DOCUMENT READING
# ─────────────────────────────────────────

# Maximum characters sent to the embedding model and stored in Pinecone metadata.
# Gemini embedding-2 context window is effectively ~8k tokens; Pinecone metadata
# strings are limited to 40 KB — we stay well inside both.
_MAX_PDF_CHARS = 8000

def read_medical_document(file_path: str | None) -> str | None:
    """
    Reads text from an uploaded PDF medical history document.

    Strategy:
      1. Try PyPDF2 (fast, handles most modern PDFs).
      2. If PyPDF2 fails or returns empty text, try pypdf (modern successor,
         handles more edge-cases like XRef repairs, certain compression types).
      3. Cap returned text at _MAX_PDF_CHARS to stay within embedding model limits.

    Returns None if the file doesn't exist, cannot be parsed, or is image-only
    (scanned PDF with no embedded text layer).
    """
    if not file_path or not os.path.exists(file_path):
        return None
    print(f"📄 Reading medical document: {file_path}")

    # ── Pass 1: PyPDF2 ────────────────────────────────────────────────────────
    text = ""
    try:
        import PyPDF2
        with open(file_path, "rb") as f:
            reader = PyPDF2.PdfReader(f)
            if reader.is_encrypted:
                print("⚠️  Document is encrypted/password-protected — cannot extract text.")
                return None
            for page in reader.pages:
                extracted = page.extract_text()
                if extracted:
                    text += extracted + "\n"
        text = text.strip()
        if text:
            print(f"   [PyPDF2] Extracted {len(text)} chars.")
            return text[:_MAX_PDF_CHARS]
        print("   [PyPDF2] Zero text extracted — trying pypdf fallback...")
    except Exception as e:
        print(f"   [PyPDF2] Parse error: {e} — trying pypdf fallback...")

    # ── Pass 2: pypdf (modern successor, handles more PDF variants) ───────────
    try:
        import pypdf
        with open(file_path, "rb") as f:
            reader = pypdf.PdfReader(f)
            if reader.is_encrypted:
                print("⚠️  Document is encrypted/password-protected — cannot extract text.")
                return None
            for page in reader.pages:
                extracted = page.extract_text()
                if extracted:
                    text += extracted + "\n"
        text = text.strip()
        if text:
            print(f"   [pypdf] Extracted {len(text)} chars.")
            return text[:_MAX_PDF_CHARS]
        print("   [pypdf] Zero text extracted — PDF may be image-only (scanned).")
    except ImportError:
        print("   [pypdf] Not installed. Install `pypdf` for better PDF support.")
    except Exception as e:
        print(f"   [pypdf] Parse error: {e}")

    return None


# ─────────────────────────────────────────
# PIPELINE STEPS
# ─────────────────────────────────────────

def extract_symptoms_with_llm(patient_summary: str) -> list[str]:
    """Uses Groq/LLaMA to extract a structured symptom list from the intake summary."""
    print("[Groq] Extracting symptoms...")
    system_prompt = (
        "You are a medical extraction assistant. Extract all current symptoms from the patient summary. "
        "Return ONLY a raw JSON array of lowercase strings. No markdown, no explanation. "
        'Example: ["headache", "fever", "nausea"]'
    )
    user_prompt = f"Patient Summary: {patient_summary}\n"

    resp = groq_client.chat.completions.create(
        model="llama-3.1-8b-instant",
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        temperature=0.1,
        max_tokens=256,
    )
    raw = resp.choices[0].message.content.strip()
    try:
        # Strip any accidental markdown fences
        clean = re.sub(r"```[a-z]*", "", raw).strip().strip("`")
        symptoms = json.loads(clean)
        print(f"   -> Symptoms: {symptoms}")
        return symptoms if isinstance(symptoms, list) else []
    except Exception:
        print("   [!]  Symptom parse failed – falling back to comma split")
        return [s.strip() for s in patient_summary.lower().split(",") if s.strip()]


def pass_1_neo4j_graph_search(symptoms: list[str]) -> list[str]:
    """
    PASS 1: Neo4j Disease Relationship & Chain Discovery.
    Uses the LLM to expand symptoms into clinical terms, then traverses
    the graph using CONTAINS matching against Disease node names.
    Walks 1 hop to find related diseases in the knowledge chain.
    """
    print("[Pass 1: Neo4j] Disease graph traversal...")
    if not symptoms:
        return []

    # Step A: Use LLM to expand layperson symptoms into short medical keywords
    # that will hit Disease node names in Neo4j via CONTAINS matching.
    try:
        system_prompt = (
            "You are a medical terminology mapper for a disease graph database. "
            "The database has Disease nodes with names like: 'Anterior cruciate ligament injury', "
            "'Rheumatoid arthritis', 'Joint dislocation', 'Cold sensitivity', 'Arthritis', 'Inflammation'. "
            "Given patient symptoms, output short medical keywords (1-3 words each) that are likely to appear "
            "as substrings inside those Disease node names. "
            "Focus on anatomical parts, injury types, and condition root words. "
            "DO NOT output full sentences or descriptions. "
            "Return ONLY a raw JSON array of lowercase strings. "
            "Example input: ['knee pain', 'stiff joints', 'cold worsens pain'] "
            "Example output: ['ligament', 'arthritis', 'joint', 'inflammation', 'cold', 'rheumatoid']"
        )
        resp = groq_client.chat.completions.create(
            model="llama-3.1-8b-instant",
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": json.dumps(symptoms)},
            ],
            temperature=0.0,
            max_tokens=150,
        )
        raw = re.sub(r"```[a-z]*", "", resp.choices[0].message.content.strip()).strip().strip("`")
        synonyms = json.loads(raw)
        if isinstance(synonyms, list):
            search_terms = list(set(symptoms + [s.lower() for s in synonyms]))
        else:
            search_terms = symptoms
    except Exception:
        search_terms = symptoms

    print(f"   -> Searching terms: {search_terms}")

    # Step B: Find Disease nodes whose name CONTAINS any search term (bidirectional CONTAINS),
    #         then traverse 1 hop to find clinically related disease chains.
    query = """
    MATCH (seed:Disease)
    WHERE ANY(term IN $terms
              WHERE toLower(seed.name) CONTAINS toLower(term)
                 OR toLower(term) CONTAINS toLower(seed.name))
    WITH seed, $terms AS terms
    MATCH (seed)--(related:Disease)
    WHERE related <> seed
    RETURN related.name AS disease,
           collect(DISTINCT seed.name) AS via_nodes,
           count(seed) AS relevance
    ORDER BY relevance DESC
    LIMIT 6
    """
    diseases = []
    try:
        with neo4j_driver.session() as session:
            result = session.run(query, terms=search_terms)
            for record in result:
                d = record["disease"]
                diseases.append(d)
                print(f"   -> {d}  (via: {record['via_nodes']})")
        if not diseases:
            print("   [!] No graph matches. Try broader symptoms.")
    except Exception as e:
        print(f"   [!] Neo4j error: {e}")

    return diseases


def pass_2_pinecone_disease_context(
    symptoms: list[str],
    target_diseases: list[str],
) -> tuple[str, list[str]]:
    """
    PASS 2: Pinecone Disease Knowledge Retrieval.
    Fetches clinical descriptions for the diseases found in Pass 1.
    If Neo4j returned diseases, filters Pinecone to those exact diseases.
    If Neo4j returned nothing, performs a free semantic search on symptoms.
    Strictly caps the returned text to prevent 413 token overflow.
    """
    print("[Pass 2: Pinecone] Disease knowledge retrieval...")

    query_text = " ".join(symptoms)
    vector = get_embedding(query_text)

    # Token budget: cap each chunk at 400 chars, max 4 chunks = ~1600 chars total
    MAX_CHUNKS = 4
    MAX_CHARS_PER_CHUNK = 400

    clinical_context = ""
    semantic_diseases = []

    try:
        query_args = {
            "vector": vector,
            "top_k": MAX_CHUNKS,
            "include_metadata": True,
            "filter": {"type": {"$ne": "medical_history"}},
        }
        # If Neo4j found specific diseases, focus Pinecone on those
        if target_diseases:
            query_args["filter"] = {"disease_name": {"$in": target_diseases}}

        res = pinecone_index.query(**query_args)
        matches = res.get("matches", [])

        # If filtered query returns nothing, fall back to free semantic search
        if not matches and target_diseases:
            print("   -> No Pinecone match for Neo4j diseases. Doing free semantic search...")
            query_args["filter"] = {"type": {"$ne": "medical_history"}}
            res = pinecone_index.query(**query_args)
            matches = res.get("matches", [])

        for match in matches:
            meta = match.get("metadata", {})
            d_name = meta.get("disease_name")
            if not d_name or d_name == "Unknown":
                continue
            if d_name not in semantic_diseases:
                semantic_diseases.append(d_name)
            # Truncate each chunk strictly to avoid token overflow
            chunk_text = meta.get("text", "")[:MAX_CHARS_PER_CHUNK]
            clinical_context += f"**{d_name}**: {chunk_text}...\n\n"
            print(f"   -> Clinical info: {d_name} (score={match.get('score', 0):.3f})")

    except Exception as e:
        print(f"   [!] Disease context error: {e}")

    return clinical_context, semantic_diseases


def pass_3_pinecone_patient_history(
    symptoms: list[str],
    user_id: str | None,
) -> str:
    """
    PASS 3: Pinecone Patient Personal History Retrieval.
    Fetches the patient's own stored medical history records from Pinecone,
    filtered strictly by user_id. Caps output to prevent token overflow.
    """
    print("[Pass 3: Pinecone] Patient history retrieval...")
    patient_history_context = ""

    if not user_id or user_id in ("guest", ""):
        print("   -> No user ID provided, skipping.")
        return ""

    # Token budget: max 3 records, each capped at 500 chars
    MAX_RECORDS = 3
    MAX_CHARS_PER_RECORD = 500

    query_text = " ".join(symptoms)
    vector = get_embedding(query_text)

    try:
        res = pinecone_index.query(
            vector=vector,
            filter={"user_id": {"$eq": user_id}},
            top_k=MAX_RECORDS,
            include_metadata=True,
        )
        for match in res.get("matches", []):
            meta = match.get("metadata", {})
            text = meta.get("text", "")[:MAX_CHARS_PER_RECORD]
            date = meta.get("date", "N/A")
            patient_history_context += f"**Record ({date})**: {text}\n\n"
            print(f"   -> History record found (date={date})")

        if not patient_history_context:
            print("   -> No personal history records found.")
    except Exception as e:
        print(f"   [!] Patient history error: {e}")

    return patient_history_context


def generate_consultation_report(
    patient_summary: str,
    symptoms: list[str],
    diseases: list[str],
    clinical_context: str,
    patient_history_context: str = "",
    conversation_transcript: str = "",
) -> str:
    """Generates the final structured Doctor's Consultation Brief.
    Uses llama-3.1-8b-instant which has a 30K TPM limit — well above our budget.
    All context inputs are pre-capped upstream to guarantee no 413 overflow.
    """
    print("[Pass: Report] Generating consultation report...")

    system_prompt = (
        "You are an AI clinical assistant preparing a detailed, physician-ready consultation brief. "
        "Your output must be rich, substantive, and informative — not just bullet lists. "
        "For every disease or condition mentioned, include: "
        "(a) a 2-3 sentence clinical definition/overview using your medical knowledge, "
        "(b) its typical presentation and hallmark signs, "
        "(c) how it specifically relates to this patient's reported symptoms. "
        "Use medical terminology appropriately. "
        "Highlight correlations between past history and current presentation. "
        "End with a disclaimer that this is AI-generated and not a diagnosis. "
        "Use rich Markdown: **bold** for key terms, ### for section headers, - for bullets. "
        "IMPORTANT: Do NOT leave multiple blank lines between sections — use exactly one blank line between sections."
    )

    # Transcript: cap at 800 chars to stay within token budget
    transcript_excerpt = (conversation_transcript or "")[:800]

    user_prompt = f"""PATIENT INTAKE SUMMARY:
{patient_summary}

EXTRACTED SYMPTOMS:
{', '.join(symptoms)}

### PASS 1 — Neo4j Graph DB Findings:
Probable conditions identified: {', '.join(diseases) if diseases else 'No direct graph matches.'}

### PASS 2 — Clinical Knowledge Base (Pinecone):
{clinical_context if clinical_context else 'No clinical context retrieved.'}

### PASS 3 — Patient Personal History (Pinecone):
{patient_history_context if patient_history_context else 'No prior records for this patient.'}

CONVERSATION EXCERPT:
{transcript_excerpt if transcript_excerpt else 'Not available.'}

Generate a detailed, content-rich Markdown consultation report with these sections:

### 1. Patient Summary
- Demographics, chief complaint, duration, severity

### 2. Presenting Complaints & Symptom Analysis
- Each symptom with clinical interpretation (2-3 sentences per symptom)

### 3. Relevant Medical History
- Past conditions, medications, allergies, surgical history with clinical relevance

### 4. Graph DB Diagnostic Findings (Pass 1)
- For each identified condition: definition, typical presentation, relevance to this patient's symptoms

### 5. Clinical Knowledge Base Notes (Pass 2)
- Detailed clinical notes per condition from the knowledge base

### 6. Differential Considerations (for physician review)
- Ranked differentials with brief clinical rationale for each

### 7. Recommended Next Steps
- Specific investigations, specialist referrals, red-flag criteria for urgent care

### 8. Disclaimer
"""

    resp = groq_client.chat.completions.create(
        model="llama-3.1-8b-instant",   # 30K TPM limit — safe for all contexts
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        temperature=0.3,
        max_tokens=2500,
    )
    return resp.choices[0].message.content


def _normalize_whitespace(text: str) -> str:
    """Collapses 3+ consecutive blank lines into a single blank line to clean up LLM output."""
    import re
    # Replace 3 or more consecutive newlines with exactly 2 (one blank line)
    text = re.sub(r'\n{3,}', '\n\n', text)
    # Also remove trailing spaces on each line
    text = '\n'.join(line.rstrip() for line in text.split('\n'))
    return text.strip()


def pass_4_verify_and_refine_report(
    patient_summary: str,
    symptoms: list[str],
    raw_report: str,
) -> str:
    """
    PASS 4: AI Verification, Enrichment & Hallucination Removal.
    Uses llama-3.1-8b-instant to:
    1. Remove clinically irrelevant diseases
    2. Enrich each kept disease with its definition and clinical details
    3. Add standard clinical duties
    4. Fix blank-line spacing issues
    Lightweight — single LLM call, no new dependencies, Lambda-safe.
    """
    print("[Pass 4: Verifier] Auditing and enriching report...")

    system_prompt = (
        "You are a strict clinical report auditor and enrichment specialist for a pre-consultation AI system. "
        "Your job is to audit and refine a draft medical report using these rules:\n\n"
        "CLEANING RULES:\n"
        "1. REMOVE any disease or condition that has NO plausible clinical connection to the patient's stated symptoms. "
        "For example, if the patient has a headache, remove Pregnancy, Urethritis, Cardiac arrest unless explicitly relevant.\n"
        "2. REMOVE any hallucinated facts not supported by the patient's actual data.\n"
        "3. KEEP diseases only if they are clinically related to the reported symptoms.\n\n"
        "ENRICHMENT RULES:\n"
        "4. For every disease or condition that remains, write a dedicated sub-section with:\n"
        "   a) **Definition**: A clear 2-3 sentence clinical definition of the condition.\n"
        "   b) **Typical Presentation**: Key signs, symptoms, and hallmark features of the disease.\n"
        "   c) **Relevance to Patient**: Why this condition is being considered given this patient's specific symptoms.\n"
        "5. In the Recommended Next Steps section, ensure these clinical duties are present:\n"
        "   - Patient must seek in-person evaluation before any treatment\n"
        "   - List any red-flag symptoms warranting immediate/urgent care\n"
        "   - Physician must verify all AI findings with clinical examination\n"  
        "   - Specific diagnostic tests or investigations recommended\n\n"
        "FORMATTING RULES:\n"
        "6. PRESERVE the exact Markdown section structure (### headers, - bullets, **bold**).\n"
        "7. Use exactly ONE blank line between sections and subsections. Do NOT leave multiple blank lines.\n"
        "8. Do NOT change the patient's name, DOB, or stated medical history.\n"
        "9. Return ONLY the refined report text. No preamble, no explanations."
    )

    # Cap the raw report to avoid token overflow in verifier pass
    capped_report = raw_report[:4500]

    user_prompt = f"""PATIENT SYMPTOMS (ground truth — use these to judge relevance):
{', '.join(symptoms)}

PATIENT SUMMARY (ground truth):
{patient_summary[:600]}

DRAFT REPORT TO AUDIT AND ENRICH:
{capped_report}

Audit, enrich each disease with definition + presentation + patient relevance, and return the final refined report."""

    try:
        resp = groq_client.chat.completions.create(
            model="llama-3.1-8b-instant",
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            temperature=0.15,
            max_tokens=2500,
        )
        verified = resp.choices[0].message.content.strip()
        # Always normalize whitespace regardless of LLM output style
        verified = _normalize_whitespace(verified)
        print("   -> Verification and enrichment complete.")
        return verified
    except Exception as e:
        print(f"   [!] Verifier error (returning original): {e}")
        return _normalize_whitespace(raw_report)   # Still normalize whitespace on fallback

# USER HISTORY (Pinecone)
# ─────────────────────────────────────────

def upload_user_history(user_id: str, text: str) -> bool:
    """Vectorises and upserts a user's medical history into Pinecone."""
    print(f"[Pinecone] Encoding history for {user_id}...")
    try:
        embedding = get_embedding(text)
        timestamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        vector_id = f"user_{user_id}_hist_{uuid.uuid4().hex[:8]}"
        pinecone_index.upsert(vectors=[{
            "id": vector_id,
            "values": embedding,
            "metadata": {
                "user_id": user_id,
                "text": text,
                "type": "medical_history",
                "date": timestamp,
            },
        }])
        print(f"   [SUCCESS] Encoded: {vector_id}")
        return True
    except Exception as e:
        print(f"   [ERROR] Upload error: {e}")
        return False


def check_user_history_exists(user_id: str) -> bool:
    """Checks whether any stored history exists for the user in Pinecone."""
    if not user_id or user_id in ("guest", ""):
        return False
    try:
        dummy = [0.0] * 384
        res = pinecone_index.query(
            vector=dummy,
            filter={"user_id": {"$eq": user_id}},
            top_k=1,
            include_metadata=False,
        )
        return len(res.get("matches", [])) > 0
    except Exception as e:
        print(f"[Pinecone] History check error: {e}")
        return False

def get_all_user_history(user_id: str) -> list[dict]:
    """Fetches all raw medical history entries for a user from Pinecone."""
    if not user_id or user_id in ("guest", ""):
        return []
    try:
        dummy = [0.0] * 384
        res = pinecone_index.query(
            vector=dummy,
            filter={"user_id": {"$eq": user_id}},
            top_k=100,
            include_metadata=True,
        )
        history = []
        for match in res.get("matches", []):
            meta = match.get("metadata", {})
            if "text" in meta:
                history.append({
                    "text": meta["text"],
                    "date": meta.get("date", "Unknown date")
                })
        # Sort by date descending if possible
        history.sort(key=lambda x: x["date"], reverse=True)
        return history
    except Exception as e:
        print(f"[Pinecone] History fetch error: {e}")
        return []

def summarize_user_history(history_list: list[dict]) -> str:
    """Uses Groq to summarize the raw user history into a clinical overview."""
    if not history_list:
        return "No past medical history available."
    print("[Groq] Summarizing user history...")
    
    raw_text = "\n\n".join([f"Date: {h['date']}\nRecord: {h['text']}" for h in history_list])
    
    system_prompt = (
        "You are an AI clinical assistant. Your task is to summarize the patient's medical history "
        "records into a cohesive, professional clinical overview. Highlight chronic conditions, past surgeries, "
        "and major health events. "
        "IMPORTANT FORMATTING: Use rich Markdown formatting. Use `**bold**` for emphasis, `###` for section headers, "
        "and `-` for bulleted lists to make it highly readable. Do not invent information."
    )
    user_prompt = f"PATIENT HISTORY RECORDS:\n{raw_text}\n\nPlease generate a structured clinical summary."
    
    try:
        resp = groq_client.chat.completions.create(
            model="llama-3.1-8b-instant",
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            temperature=0.2,
            max_tokens=1024,
        )
        return resp.choices[0].message.content.strip()
    except Exception as e:
        print(f"[!]  History summarization error: {e}")
        return "Failed to generate AI summary."
