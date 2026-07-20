"""
HealBot Pro – FastAPI Backend
New endpoints:
  POST /intake/turn   → one turn of conversational symptom gathering
  POST /consult       → full diagnostic pipeline (called after intake is complete)
  POST /upload        → medical document upload
  POST /user/history  → encode patient history to Pinecone
  GET  /user/{id}     → check patient status
"""

from fastapi import FastAPI, UploadFile, File, HTTPException, Depends, status, Form
from fastapi.security import OAuth2PasswordBearer
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv
load_dotenv()
from typing import Optional, List
import os, shutil, uuid, base64, io, asyncio
import inference

import firebase_admin
from firebase_admin import credentials, auth
from contextlib import asynccontextmanager

# ─────────────────────────────────────────
# FIREBASE ADMIN SETUP
# ─────────────────────────────────────────
# Find the downloaded JSON file dynamically
json_files = [f for f in os.listdir(".") if f.endswith(".json")]
if json_files:
    try:
        firebase_admin.get_app()
    except ValueError:
        cred = credentials.Certificate(json_files[0])
        firebase_admin.initialize_app(cred)
else:
    print("WARNING: No Firebase Admin JSON file found!")

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Validate critical environment variables
    required_keys = [
        "GROQ_API_KEY", 
        "PINECONE_API_KEY", 
        "NEO4J_URI", 
        "NEO4J_PASSWORD", 
        "GEMINI_API_KEY"
    ]
    missing = [key for key in required_keys if not os.getenv(key)]
    if missing:
        print(f"[ERROR] Missing required environment variables: {', '.join(missing)}")
        print("Please check your .env file or Lambda environment variables.")
        # We don't exit so that we can still serve the frontend with limited functionality,
        # or you can choose to exit(1) if it's strictly required.
    else:
        print("[SUCCESS] All required API keys are present!")
    yield

app = FastAPI(title="HealBot Pro API", version="2.0.0", lifespan=lifespan)

@app.get("/debug/pdf")
async def debug_pdf():
    try:
        import PyPDF2
        return {
            "status": "success",
            "message": f"PyPDF2 imported successfully. Version: {getattr(PyPDF2, '__version__', 'unknown')}"
        }
    except Exception as e:
        import traceback
        return {
            "status": "error",
            "error_type": type(e).__name__,
            "error_message": str(e),
            "traceback": traceback.format_exc()
        }


app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="login") # purely to grab the bearer token

# ─────────────────────────────────────────
# PYDANTIC MODELS
# ─────────────────────────────────────────

class UserRead(BaseModel):
    id: str
    username: str
    full_name: Optional[str] = None
    role: str

class ChatMessage(BaseModel):
    role: str
    content: str

class IntakeTurnRequest(BaseModel):
    conversation: List[ChatMessage]
    doc_path: Optional[str] = None

class IntakeTurnResponse(BaseModel):
    message: str
    intake_complete: bool
    summary: Optional[str] = None

class ConsultationRequest(BaseModel):
    patient_summary: str
    user_id: Optional[str] = None
    doc_path: Optional[str] = None
    conversation_transcript: Optional[str] = None

class ConsultationResponse(BaseModel):
    symptoms: List[str]
    diseases: List[str]
    report: str
    status: str

class HistoryUpdate(BaseModel):
    user_id: str
    text: str

class UserHistoryResponse(BaseModel):
    history: List[dict]
    ai_summary: str

# ─────────────────────────────────────────
# AUTH HELPERS
# ─────────────────────────────────────────

async def get_current_user(token: str = Depends(oauth2_scheme)) -> UserRead:
    try:
        # Verify the Firebase JWT
        decoded_token = auth.verify_id_token(token)
        return UserRead(
            id=decoded_token.get("uid"),
            username=decoded_token.get("email", ""),
            full_name=decoded_token.get("name", ""),
            role="patient"
        )
    except Exception as e:
        print(f"Auth error: {e}")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid authentication credentials",
            headers={"WWW-Authenticate": "Bearer"},
        )

# ─────────────────────────────────────────
# HEALTH & AUTH ENDPOINTS
# ─────────────────────────────────────────

@app.get("/")
def health():
    return {"status": "online", "service": "HealBot Pro API v2"}

@app.get("/users/me", response_model=UserRead)
async def read_me(current_user: UserRead = Depends(get_current_user)):
    return current_user

# ─────────────────────────────────────────
# CONVERSATIONAL INTAKE
# ─────────────────────────────────────────

@app.post("/intake/turn", response_model=IntakeTurnResponse)
async def intake_turn(req: IntakeTurnRequest):
    history = [{"role": m.role, "content": m.content} for m in req.conversation]
    result = inference.chat_intake_turn(history)
    return IntakeTurnResponse(**result)

# ─────────────────────────────────────────
# FULL DIAGNOSTIC PIPELINE
# ─────────────────────────────────────────

@app.post("/consult", response_model=ConsultationResponse)
async def consult(req: ConsultationRequest):
    print(f"\n--- /consult --- user={req.user_id}")
    try:
        # PASS 0: Extract symptoms from patient summary
        symptoms = inference.extract_symptoms_with_llm(req.patient_summary)

        # PASS 1: Neo4j graph traversal — disease relationship/chain discovery
        graph_diseases = inference.pass_1_neo4j_graph_search(symptoms)

        # PASS 2: Pinecone — fetch clinical knowledge for discovered diseases
        clinical_ctx, semantic_diseases = inference.pass_2_pinecone_disease_context(
            symptoms, graph_diseases
        )

        # PASS 3: Pinecone — fetch patient's personal history records
        history_ctx = inference.pass_3_pinecone_patient_history(symptoms, req.user_id)

        # Combine diseases from both graph and semantic sources
        all_diseases = list(dict.fromkeys(graph_diseases + semantic_diseases))  # preserve order, dedupe

        print(f"   -> Final diseases: {all_diseases}")

        # REPORT: Generate structured consultation brief
        report = inference.generate_consultation_report(
            patient_summary=req.patient_summary,
            symptoms=symptoms,
            diseases=all_diseases,
            clinical_context=clinical_ctx,
            patient_history_context=history_ctx,
            conversation_transcript=req.conversation_transcript or "",
        )

        # PASS 4: Verify and remove hallucinations from the generated report
        report = inference.pass_4_verify_and_refine_report(
            patient_summary=req.patient_summary,
            symptoms=symptoms,
            raw_report=report,
        )

        print("--- /consult complete ---\n")
        return ConsultationResponse(
            symptoms=symptoms,
            diseases=all_diseases,
            report=report,
            status="success",
        )
    except Exception as e:
        print(f"[!] /consult error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ─────────────────────────────────────────
# PATIENT HISTORY (Pinecone)
# ─────────────────────────────────────────

@app.post("/user/history")
async def update_user_history(data: HistoryUpdate):
    ok = inference.upload_user_history(data.user_id, data.text)
    if not ok:
        raise HTTPException(status_code=500, detail="Failed to encode clinical history")
    return {"status": "success", "message": "History encoded"}

# ── PDF size limit: 4 MB raw bytes (base64 adds ~33% overhead, so 4MB → ~5.3MB JSON) ──
# AWS Lambda sync Function URL limit is 6 MB. Staying at 4 MB raw keeps us safe.
_MAX_PDF_BYTES = 4 * 1024 * 1024   # 4 MB

# ── Lambda-safe timeout for the encode+upsert step (seconds) ──
# /consult makes multiple LLM calls and can take 30-45s.
# Set your Lambda timeout to 60s in the AWS console; we guard at 25s here
# so we can return a graceful error instead of being killed silently.
_EMBED_TIMEOUT_SECS = 25


def _decode_pdf_base64(raw: str) -> bytes:
    """
    Robustly decode a base64 string that may be:
      - Standard base64 (+, /)
      - URL-safe base64 (-, _)   ← causes silent PyPDF2 corruption
      - Padded or unpadded
      - Containing whitespace / newlines from some encoders
    """
    # Strip all whitespace (newlines, spaces) that some base64 implementations add
    cleaned = "".join(raw.split())
    # Normalise URL-safe characters to standard base64
    cleaned = cleaned.replace("-", "+").replace("_", "/")
    # Fix missing padding
    missing_pad = len(cleaned) % 4
    if missing_pad:
        cleaned += "=" * (4 - missing_pad)
    return base64.b64decode(cleaned)


def _extract_text_from_pdf_bytes(pdf_bytes: bytes) -> str | None:
    """
    Extract text from raw PDF bytes.
    Tries PyPDF2 first, then pypdf as fallback.
    Returns None if no text can be extracted (encrypted or image-only PDF).
    """
    text = ""

    # ── Pass 1: PyPDF2 ────────────────────────────────────────────────────────
    try:
        import PyPDF2
        reader = PyPDF2.PdfReader(io.BytesIO(pdf_bytes))
        if reader.is_encrypted:
            return None   # caller will raise 400 with clear message
        for page in reader.pages:
            t = page.extract_text()
            if t:
                text += t + "\n"
        text = text.strip()
        if text:
            print(f"   [PyPDF2] Extracted {len(text)} chars.")
            return text[:inference._MAX_PDF_CHARS]
        print("   [PyPDF2] Zero text — trying pypdf fallback...")
    except Exception as e:
        print(f"   [PyPDF2] Error: {e} — trying pypdf fallback...")

    # ── Pass 2: pypdf (modern successor, handles more edge-cases) ─────────────
    try:
        import pypdf
        reader = pypdf.PdfReader(io.BytesIO(pdf_bytes))
        if reader.is_encrypted:
            return None
        for page in reader.pages:
            t = page.extract_text()
            if t:
                text += t + "\n"
        text = text.strip()
        if text:
            print(f"   [pypdf] Extracted {len(text)} chars.")
            return text[:inference._MAX_PDF_CHARS]
        print("   [pypdf] Zero text — PDF may be image-only (scanned).")
    except ImportError:
        print("   [pypdf] Not installed.")
    except Exception as e:
        print(f"   [pypdf] Error: {e}")

    return None


class PDFUploadRequest(BaseModel):
    user_id: str
    filename: str
    file_base64: str


@app.post("/user/history/upload_pdf_base64")
async def upload_user_history_pdf_base64(req: PDFUploadRequest):
    """
    Receives a base64-encoded PDF from the frontend.
    Uses robust base64 decoding (handles URL-safe and padded variants),
    dual PDF parser (PyPDF2 → pypdf fallback), and a Lambda-aware timeout
    around the embedding + Pinecone upsert step.
    """
    print(f"\n--- /upload_pdf_base64 --- user={req.user_id}, file={req.filename}")

    # ── Step 1: Decode base64 safely ─────────────────────────────────────────
    try:
        pdf_bytes = _decode_pdf_base64(req.file_base64)
    except Exception as e:
        print(f"   [ERROR] Base64 decode failed: {e}")
        raise HTTPException(
            status_code=400,
            detail="Invalid file data: could not decode the uploaded PDF. Please try again."
        )

    # ── Step 2: Size guard ────────────────────────────────────────────────────
    if len(pdf_bytes) > _MAX_PDF_BYTES:
        size_mb = len(pdf_bytes) / (1024 * 1024)
        raise HTTPException(
            status_code=413,
            detail=f"PDF too large ({size_mb:.1f} MB). Maximum allowed size is 4 MB. "
                   f"Please compress the PDF or split it into smaller files."
        )

    print(f"   PDF decoded: {len(pdf_bytes):,} bytes")

    # ── Step 3: Extract text ──────────────────────────────────────────────────
    text = _extract_text_from_pdf_bytes(pdf_bytes)

    if text is None:
        # We got None from the parser — check if encrypted or image-only
        # We try to peek at encryption status for the error message
        is_encrypted = False
        try:
            import PyPDF2
            r = PyPDF2.PdfReader(io.BytesIO(pdf_bytes))
            is_encrypted = r.is_encrypted
        except Exception:
            pass

        if is_encrypted:
            raise HTTPException(
                status_code=400,
                detail="This PDF is password-protected and cannot be read. "
                       "Please remove the password and try again, or type your history manually."
            )
        raise HTTPException(
            status_code=400,
            detail="Could not extract text from this PDF. It may be a scanned image. "
                   "Please use a text-based PDF or type your medical history manually."
        )

    if not text.strip():
        raise HTTPException(
            status_code=400,
            detail="The PDF appears to be blank or contains no readable text."
        )

    print(f"   Text ready: {len(text)} chars -> encoding to Pinecone...")

    # ── Step 4: Embed + upsert with Lambda-safe timeout ───────────────────────
    try:
        ok = await asyncio.wait_for(
            asyncio.to_thread(inference.upload_user_history, req.user_id, text),
            timeout=_EMBED_TIMEOUT_SECS,
        )
    except asyncio.TimeoutError:
        print("   [TIMEOUT] Embedding/upsert exceeded time limit.")
        raise HTTPException(
            status_code=504,
            detail="The server took too long to process your PDF. "
                   "Please try again with a shorter document."
        )
    except Exception as e:
        print(f"   [ERROR] Embedding/upsert failed: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Your PDF was read successfully, but storing it failed: {e}. "
                   f"Please try again."
        )

    if not ok:
        raise HTTPException(
            status_code=500,
            detail="Your PDF was read successfully, but could not be stored. "
                   "Please check your Pinecone configuration and try again."
        )

    print("--- /upload_pdf_base64 complete ---\n")
    return {"status": "success", "message": "PDF history encoded successfully"}


@app.post("/user/history/upload_pdf")
async def upload_user_history_pdf(user_id: str = Form(...), file: UploadFile = File(...)):
    """
    Multipart file upload fallback (not used by Lambda frontend, but kept
    for local dev / direct API testing).
    """
    temp_dir = "temp_uploads"
    os.makedirs(temp_dir, exist_ok=True)
    ext = os.path.splitext(file.filename or "")[1]
    fname = f"{uuid.uuid4()}{ext}"
    fpath = os.path.join(temp_dir, fname)

    try:
        with open(fpath, "wb") as buf:
            shutil.copyfileobj(file.file, buf)

        doc_text = inference.read_medical_document(fpath)

        if doc_text is None:
            raise HTTPException(
                status_code=400,
                detail="Could not extract text from the uploaded PDF. "
                       "It may be scanned/image-only or password-protected."
            )

        ok = inference.upload_user_history(user_id, doc_text)
        if not ok:
            raise HTTPException(
                status_code=500,
                detail="PDF text extracted but could not be stored. Check Pinecone config."
            )
        return {"status": "success", "message": "PDF history encoded"}
    finally:
        # Always clean up temp file
        if os.path.exists(fpath):
            os.remove(fpath)

@app.get("/user/{user_id}")
async def get_user_status(user_id: str):
    # Check Pinecone directly
    has_history = inference.check_user_history_exists(user_id)
    return {"user_id": user_id, "has_history": has_history, "status": "Firebase User"}

@app.get("/user/{user_id}/history", response_model=UserHistoryResponse)
async def get_user_history_data(user_id: str):
    history_list = inference.get_all_user_history(user_id)
    ai_summary = inference.summarize_user_history(history_list)
    return UserHistoryResponse(history=history_list, ai_summary=ai_summary)

# ─────────────────────────────────────────
# TEXT-TO-SPEECH  (edge-tts – free, no key needed)
# Returns MP3 audio bytes for the CallInterface
# ─────────────────────────────────────────

from fastapi.responses import StreamingResponse
import io
import edge_tts

class TTSRequest(BaseModel):
    text: str
    lang: str = "en"

@app.post("/tts")
async def text_to_speech(req: TTSRequest):
    """
    Convert text to speech using edge-tts (Microsoft Edge TTS).
    It is free, requires no API key, and produces natural-sounding audio.
    It reliably works on AWS Lambda, preventing fallback to the default browser voice.
    Returns MP3 audio that the frontend plays directly.
    """
    try:
        # Default energetic female voice for edge-tts
        voice = "en-US-AriaNeural"
        
        # Limit text length just in case
        text_to_speak = req.text[:1000]
        
        communicate = edge_tts.Communicate(text_to_speak, voice)
        
        async def audio_stream():
            async for chunk in communicate.stream():
                if chunk["type"] == "audio":
                    yield chunk["data"]
                    
        return StreamingResponse(
            audio_stream(),
            media_type="audio/mpeg",
            headers={"Cache-Control": "no-cache"},
        )
    except Exception as e:
        print(f"TTS error: {e}")
        raise HTTPException(status_code=500, detail=f"TTS failed: {e}")

from mangum import Mangum
handler = Mangum(app)
if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 8002))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)
