import os
import json
import asyncio
import logging
import sys, time
import uvicorn
import uuid
import aiohttp  # Replace requests with aiohttp
from fastapi import FastAPI, WebSocket, BackgroundTasks, HTTPException, Request, Response, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import Any, Callable, TypeVar, Optional, Dict
from sqlalchemy import create_engine, Column, String, DateTime, Text
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker, Session
from datetime import datetime
from dotenv import load_dotenv
from contextlib import asynccontextmanager

# Load environment variables
load_dotenv()

# Configure logging
logging.basicConfig(
    stream=sys.stdout,
    level=logging.INFO,
    format="[%(asctime)s] %(levelname)s [%(name)s.%(funcName)s:%(lineno)d] %(message)s",
    datefmt="%d/%b/%Y %H:%M:%S",
)
logger = logging.getLogger(__name__)

# Secure environment variables
RUNPOD_API_KEY = os.getenv("RUNPOD_API_KEY")
RUNPOD_ENDPOINT_ID = os.getenv("RUNPOD_ENDPOINT_ID", "fswz4ju3asche1")
RUNPOD_API_URL = f"https://api.runpod.ai/v2/{RUNPOD_ENDPOINT_ID}/run"
DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./data/runpod_jobs.db")
PUBLIC_URL = os.getenv("PUBLIC_URL", "https://health-services-43i9.onrender.com")

if not RUNPOD_API_KEY:
    raise ValueError("Missing required RUNPOD_API_KEY environment variable!")

# Headers for RunPod API
HEADERS = {
    'Content-Type': 'application/json',
    'Authorization': f'Bearer {RUNPOD_API_KEY}'
}

# Job expiry time (1 hour = 3600 seconds)
JOB_EXPIRY = 3600

# Database setup
engine = create_engine(DATABASE_URL)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

class JobRecord(Base):
    __tablename__ = "job_records"
    
    id = Column(String, primary_key=True, index=True)
    runpod_id = Column(String, index=True, nullable=True)
    status = Column(String, index=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    prompt = Column(Text)
    result = Column(Text, nullable=True)

# Create database tables
@asynccontextmanager
async def lifespan(app: FastAPI):
    # Setup - Create tables if they don't exist
    Base.metadata.create_all(bind=engine)
    logger.info("Database tables created")
    yield
    # Cleanup - Nothing to clean up for now

# Initialize FastAPI with lifespan
app = FastAPI(
    title="RunPod API Integration",
    description="A FastAPI service for interfacing with RunPod AI",
    version="1.0.0",
    lifespan=lifespan,
    docs_url="/docs",
    openapi_url="/openapi.json"
)

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Adjust for production security
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Dependency to get the database session
def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

# Middleware for logging request processing time
F = TypeVar("F", bound=Callable[..., Any])

@app.middleware("http")
async def process_time_log_middleware(request: Request, call_next: F) -> Response:
    """Add API process time in response headers and log calls"""
    start_time = time.time()
    response: Response = await call_next(request)
    process_time = str(round(time.time() - start_time, 3))
    response.headers["X-Process-Time"] = process_time

    logger.info(
        "Method=%s Path=%s StatusCode=%s ProcessTime=%s",
        request.method,
        request.url.path,
        response.status_code,
        process_time,
    )

    return response

# Error handlers
@app.exception_handler(HTTPException)
async def http_exception_handler(request, exc):
    return JSONResponse(
        status_code=exc.status_code,
        content={"message": exc.detail},
    )

@app.exception_handler(Exception)
async def global_exception_handler(request, exc):
    logger.error(f"Unexpected error: {str(exc)}")
    return JSONResponse(
        status_code=500,
        content={"message": f"An unexpected error occurred. {str(exc)}"},
    )

# Pydantic models
class JobRequest(BaseModel):
    prompt: str
    
class JobResponse(BaseModel):
    job_id: str
    status: str
    result: Optional[Dict[str, Any]] = None

class WebhookPayload(BaseModel):
    id: str
    status: str
    output: Optional[Dict[str, Any]] = None

# Health check endpoint
@app.get("/health")
async def health_check():
    return {"status": "ok", "message": "API is running smoothly", "timestamp": datetime.utcnow().isoformat()}

# Submit job endpoint
@app.post("/submit-job", response_model=JobResponse)
async def submit_job(request: JobRequest, background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    """Submits a job to RunPod and starts async processing."""
    # Generate a unique ID for this job
    job_id = str(uuid.uuid4())
    
    # Determine webhook URL (use custom if provided, otherwise use our endpoint)
    webhook_url = "https://health-services-43i9.onrender.com/webhook"
    
    # Create a new job record
    new_job = JobRecord(
        id=job_id,
        status="PENDING",
        prompt=request.prompt,
    )
    db.add(new_job)
    db.commit()
    
    # Submit the job to RunPod asynchronously
    background_tasks.add_task(submit_runpod_job, job_id, request.prompt, webhook_url, db)
    
    return JobResponse(job_id=job_id, status="PENDING")

# Background task to submit job to RunPod - FIXED VERSION
async def submit_runpod_job(job_id: str, prompt: str, webhook_url: str, db: Session):
    try:
        data = {
            'input': {"prompt": prompt},
            'webhook': webhook_url
        }
        
        # Use aiohttp instead of requests for async HTTP
        async with aiohttp.ClientSession() as session:
            async with session.post(
                RUNPOD_API_URL, 
                headers=HEADERS, 
                json=data, 
                timeout=aiohttp.ClientTimeout(total=30)
            ) as response:
                if response.status == 200:
                    response_data = await response.json()
                    runpod_job_id = response_data.get('id')
                    
                    # Update the job record with RunPod's job ID and status
                    db_job = db.query(JobRecord).filter(JobRecord.id == job_id).first()
                    if db_job:
                        db_job.runpod_id = runpod_job_id
                        db_job.status = "SUBMITTED"
                        db.commit()
                    
                    logger.info(f"Job {job_id} submitted to RunPod with ID {runpod_job_id}")
                    
                    # Start polling if no webhook URL is provided or if it's our own webhook
                    if webhook_url == "https://health-services-43i9.onrender.com/webhook":
                        asyncio.create_task(poll_runpod_job(job_id, runpod_job_id, db))
                else:
                    # Update job status to failed
                    response_text = await response.text()
                    db_job = db.query(JobRecord).filter(JobRecord.id == job_id).first()
                    if db_job:
                        db_job.status = "FAILED"
                        db_job.result = f"Failed to submit to RunPod: {response_text}"
                        db.commit()
                    
                    logger.error(f"Failed to submit job {job_id} to RunPod: {response_text}")
                    
    except Exception as e:
        # Update job status to failed
        db_job = db.query(JobRecord).filter(JobRecord.id == job_id).first()
        if db_job:
            db_job.status = "FAILED"
            db_job.result = f"Error submitting to RunPod: {str(e)}"
            db.commit()
            
        logger.error(f"Error submitting job {job_id} to RunPod: {str(e)}")

# Poll RunPod API for job completion - FIXED VERSION
async def poll_runpod_job(job_id: str, runpod_job_id: str, db: Session):
    """Continuously polls RunPod API until job completes."""
    logger.info(f"Polling job {job_id} (RunPod ID: {runpod_job_id}) status...")

    poll_count = 0
    max_polls = 60  # 5 minutes max (with 5-second intervals)

    async with aiohttp.ClientSession() as session:
        while poll_count < max_polls:
            try:
                async with session.get(
                    f"https://api.runpod.ai/v2/{RUNPOD_ENDPOINT_ID}/status/{runpod_job_id}", 
                    headers=HEADERS, 
                    timeout=aiohttp.ClientTimeout(total=10)
                ) as response:
                    if response.status != 200:
                        logger.error(f"Error polling job {job_id}: HTTP {response.status}")
                        await asyncio.sleep(5)
                        poll_count += 1
                        continue
                    
                    status_json = await response.json()
                    status = status_json.get("status")

                    # Update job in database
                    db_job = db.query(JobRecord).filter(JobRecord.id == job_id).first()
                    if not db_job:
                        logger.error(f"Job {job_id} not found in database during polling")
                        break

                    if status == "COMPLETED":
                        result = status_json.get("output")
                        db_job.status = "COMPLETED"
                        db_job.result = json.dumps(result) if result else None
                        db.commit()
                        logger.info(f"Job {job_id} completed successfully!")
                        break
                    elif status == "FAILED":
                        db_job.status = "FAILED"
                        db_job.result = json.dumps(status_json.get("error", "No error details provided"))
                        db.commit()
                        logger.error(f"Job {job_id} failed!")
                        break
                    
                    # Still in progress
                    db_job.status = status
                    db.commit()

                poll_count += 1
                await asyncio.sleep(5)

            except Exception as e:
                logger.error(f"Error polling job {job_id}: {e}")
                
                # Update job status on error
                try:
                    db_job = db.query(JobRecord).filter(JobRecord.id == job_id).first()
                    if db_job:
                        db_job.status = "POLLING_ERROR"
                        db_job.result = f"Error polling job: {str(e)}"
                        db.commit()
                except Exception as db_error:
                    logger.error(f"Failed to update job status in database: {db_error}")
                    
                await asyncio.sleep(5)
                poll_count += 1

    # If we've reached max polls, update as timed out
    if poll_count >= max_polls:
        try:
            db_job = db.query(JobRecord).filter(JobRecord.id == job_id).first()
            if db_job:
                db_job.status = "TIMEOUT"
                db_job.result = "Job polling timed out after 5 minutes"
                db.commit()
                logger.warning(f"Job {job_id} polling timed out")
        except Exception as e:
            logger.error(f"Failed to update timeout status: {e}")

# Get job status endpoint
@app.get("/job/{job_id}", response_model=JobResponse)
async def get_job_status(job_id: str, db: Session = Depends(get_db)):
    """Get the status of a job by ID."""
    job = db.query(JobRecord).filter(JobRecord.id == job_id).first()
    
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    
    # Parse result JSON if it exists
    result = None
    if job.result:
        try:
            result = json.loads(job.result)
        except json.JSONDecodeError:
            result = {"error": "Could not parse result as JSON", "raw": job.result}
    
    return JobResponse(
        job_id=job.id,
        status=job.status,
        result=result
    )

# WebSocket endpoint for real-time updates
@app.websocket("/ws/{job_id}")
async def websocket_endpoint(websocket: WebSocket, job_id: str, db: Session = Depends(get_db)):
    """Provides real-time updates on job status via WebSocket."""
    await websocket.accept()
    
    try:
        # Send initial job status
        job = db.query(JobRecord).filter(JobRecord.id == job_id).first()
        if job:
            await websocket.send_json({
                "job_id": job.id,
                "status": job.status,
                "result": json.loads(job.result) if job.result and job.result != "null" else None
            })
        else:
            await websocket.send_json({"error": "Job not found"})
            await websocket.close()
            return
        
        # Poll for updates
        last_status = job.status
        last_result = job.result
        
        while True:
            await asyncio.sleep(2)  # Poll every 2 seconds
            
            # Re-fetch job from database
            db.refresh(job)
            
            # If status or result changed, send update
            if job.status != last_status or job.result != last_result:
                last_status = job.status
                last_result = job.result
                
                try:
                    result_data = json.loads(job.result) if job.result and job.result != "null" else None
                except json.JSONDecodeError:
                    result_data = {"error": "Could not parse result as JSON", "raw": job.result}
                    
                await websocket.send_json({
                    "job_id": job.id,
                    "status": job.status,
                    "result": result_data
                })
                
                # Close connection if job is completed or failed
                if job.status in ["COMPLETED", "FAILED", "TIMEOUT", "POLLING_ERROR"]:
                    await websocket.close()
                    break
                    
    except Exception as e:
        logger.error(f"WebSocket error for job {job_id}: {e}")
        try:
            await websocket.close()
        except:
            pass

# Webhook endpoint
@app.post("/webhook")
async def webhook_handler(data: dict, request: Request, db: Session = Depends(get_db)):
    """Receives webhook callbacks from RunPod."""
    logger.info(f"Webhook received: {json.dumps(data)}")
    
    runpod_job_id = data.get("id")
    status = data.get("status")
    output = data.get("output")
    
    if not runpod_job_id:
        logger.warning("Webhook received without job ID")
        return {"message": "No job ID provided"}
    
    # Find the job by RunPod's job ID
    job = db.query(JobRecord).filter(JobRecord.runpod_id == runpod_job_id).first()
    
    if not job:
        logger.warning(f"Webhook received for unknown RunPod job ID: {runpod_job_id}")
        return {"message": "Job not found"}
    
    # Update job status and result
    job.status = status
    
    if output:
        job.result = json.dumps(output)
    
    db.commit()
    logger.info(f"Job {job.id} updated via webhook: status={status}")
    
    return {"message": "Webhook processed successfully"}

# For local development
if __name__ == "__main__":
    port = int(os.getenv("PORT", 8000))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)