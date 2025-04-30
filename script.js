// DOM Elements
const container = document.querySelector(".container");
const chatsContainer = document.querySelector(".chats-container");
const promptForm = document.querySelector(".prompt-form");
const promptInput = promptForm.querySelector(".prompt-input");
const fileInput = promptForm.querySelector("#file-input");
const fileUploadWrapper = promptForm.querySelector(".file-upload-wrapper");
const themeToggleBtn = document.querySelector("#theme-toggle-btn");

// API Setup for health services
const API_BASE_URL = 'https://health-services-43i9.onrender.com';
let controller, typingInterval;
let websocket = null;
let currentJobId = null;
let jobHistory = [];

// Chat state
const chatHistory = [];
const userData = { message: "", file: {} };

// Set initial theme from local storage
const isLightTheme = localStorage.getItem("themeColor") === "light_mode";
document.body.classList.toggle("light-theme", isLightTheme);
themeToggleBtn.textContent = isLightTheme ? "dark_mode" : "light_mode";

// Function to create message elements
const createMessageElement = (content, ...classes) => {
  const div = document.createElement("div");
  div.classList.add("message", ...classes);
  div.innerHTML = content;
  return div;
};

// Scroll to the bottom of the container
const scrollToBottom = () => container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });

// Simulate typing effect for bot responses
const typingEffect = (text, textElement, botMsgDiv) => {
  textElement.textContent = "";
  const words = text.split(" ");
  let wordIndex = 0;
  // Set an interval to type each word
  typingInterval = setInterval(() => {
    if (wordIndex < words.length) {
      textElement.textContent += (wordIndex === 0 ? "" : " ") + words[wordIndex++];
      scrollToBottom();
    } else {
      clearInterval(typingInterval);
      botMsgDiv.classList.remove("loading");
      document.body.classList.remove("bot-responding");
    }
  }, 40); // 40 ms delay
};

// Load job history from localStorage
function loadJobHistory() {
  const storedHistory = localStorage.getItem('jobHistory');
  if (storedHistory) {
    jobHistory = JSON.parse(storedHistory);
  }
}

// Save job to history
function saveToHistory(jobId, prompt, status = 'PENDING') {
  // Add job to beginning of array (most recent first)
  jobHistory.unshift({
    id: jobId,
    prompt: prompt.substring(0, 50) + (prompt.length > 50 ? '...' : ''),
    status: status,
    timestamp: new Date().toISOString()
  });
  
  // Keep only 10 most recent jobs
  if (jobHistory.length > 10) {
    jobHistory = jobHistory.slice(0, 10);
  }
  
  // Save to localStorage
  localStorage.setItem('jobHistory', JSON.stringify(jobHistory));
}

// Update job status in history
function updateJobStatusInHistory(jobId, status) {
  const index = jobHistory.findIndex(job => job.id === jobId);
  if (index !== -1) {
    jobHistory[index].status = status;
    localStorage.setItem('jobHistory', JSON.stringify(jobHistory));
  }
}

// Submit a new job
async function submitJob(prompt, fileData = null) {
  try {
    // Create job payload
    let payload = { prompt };
    
    // Add file data if present
    if (fileData && fileData.data) {
      payload.file = {
        name: fileData.fileName,
        mime_type: fileData.mime_type,
        data: fileData.data
      };
    }
    
    const response = await fetch(`${API_BASE_URL}/submit-job`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    
    if (!response.ok) {
      throw new Error(`Error: ${response.status}`);
    }
    
    const data = await response.json();
    saveToHistory(data.job_id, prompt);
    connectToJob(data.job_id);
    
    return data.job_id;
  } catch (error) {
    console.error('Error submitting job:', error);
    showToast('Failed to submit job: ' + error.message);
    return null;
  }
}

// Get job status via REST API
async function getJobStatus(jobId) {
  try {
    const response = await fetch(`${API_BASE_URL}/job/${jobId}`);
    
    if (!response.ok) {
      throw new Error(`Error: ${response.status}`);
    }
    
    return await response.json();
  } catch (error) {
    console.error('Error getting job status:', error);
    return null;
  }
}

// Connect to WebSocket for real-time updates
function connectToJob(jobId) {
  // Close any existing websocket connection
  if (websocket && websocket.readyState !== WebSocket.CLOSED) {
    websocket.close();
  }
  
  currentJobId = jobId;
  
  // Create a new websocket connection
  const wsUrl = `${API_BASE_URL.replace('https://', 'wss://').replace('http://', 'ws://')}/ws/${jobId}`;
  websocket = new WebSocket(wsUrl);
  
  websocket.onopen = function(evt) {
    console.log('WebSocket connection established');
  };
  
      websocket.onmessage = function(evt) {
    try {
      const data = JSON.parse(evt.data);
      
      // Check if the message is a job update or the actual result
      if (data.status) {
        // This is a job status update
        handleJobUpdate(data);
      } else {
        // This might be the direct result
        const resultData = {
          job_id: jobId,
          status: 'COMPLETED',
          result: data
        };
        handleJobUpdate(resultData);
      }
    } catch (error) {
      console.error('WebSocket message parsing error:', error);
    }
  };
  
  websocket.onerror = function(evt) {
    console.error('WebSocket error:', evt);
    // Fall back to REST API polling if WebSocket fails
    pollJobStatus(jobId);
  };
  
  websocket.onclose = function(evt) {
    console.log('WebSocket connection closed');
  };
}

// Poll job status as fallback if WebSocket fails
function pollJobStatus(jobId) {
  const pollInterval = setInterval(async () => {
    const data = await getJobStatus(jobId);
    if (!data) return;
    
    handleJobUpdate(data);
    
    // Stop polling if job is complete
    if (['COMPLETED', 'FAILED', 'TIMEOUT', 'POLLING_ERROR'].includes(data.status)) {
      clearInterval(pollInterval);
    }
  }, 2000);
}

// Handle job update data
function handleJobUpdate(data) {
  updateJobStatusInHistory(data.job_id, data.status);
  
  // Find the bot message element associated with this job
  const botMsgDiv = document.querySelector(`.bot-message[data-job-id="${data.job_id}"]`);
  if (!botMsgDiv) return;
  
  const textElement = botMsgDiv.querySelector(".message-text");
  
  // Update the status and message based on job status
  switch (data.status) {
    case 'COMPLETED':
      clearInterval(typingInterval);
      
      try {
        // Check if the result is in the expected format
        if (data.result && Array.isArray(data.result)) {
          const responseData = data.result[0];
          
          if (responseData && responseData.job_results && responseData.job_results.health_text) {
            // Extract the health text from the response
            const healthText = responseData.job_results.health_text;
            typingEffect(healthText, textElement, botMsgDiv);
            
            // Add to chat history
            chatHistory.push({ role: "model", parts: [{ text: healthText }] });
          } else {
            // If the format is not as expected, show the raw result
            typingEffect(JSON.stringify(data.result, null, 2), textElement, botMsgDiv);
            chatHistory.push({ role: "model", parts: [{ text: JSON.stringify(data.result) }] });
          }
        } else if (data.result) {
          // Handle string or other format results
          if (typeof data.result === 'object') {
            typingEffect(JSON.stringify(data.result, null, 2), textElement, botMsgDiv);
          } else {
            typingEffect(data.result, textElement, botMsgDiv);
          }
          
          // Add to chat history
          chatHistory.push({ role: "model", parts: [{ text: data.result }] });
        }
      } catch (error) {
        console.error('Error parsing result:', error);
        textElement.textContent = "Error parsing response";
        textElement.style.color = "#d62939";
        botMsgDiv.classList.remove("loading");
        document.body.classList.remove("bot-responding");
      }
      break;
      
    case 'FAILED':
    case 'TIMEOUT':
    case 'POLLING_ERROR':
      clearInterval(typingInterval);
      textElement.textContent = `Error: ${data.status}`;
      textElement.style.color = "#d62939";
      botMsgDiv.classList.remove("loading");
      document.body.classList.remove("bot-responding");
      break;
      
    case 'IN_PROGRESS':
      textElement.textContent = "Processing...";
      break;
  }
  
  scrollToBottom();
}

// Show toast message
function showToast(message) {
  let toast = document.getElementById('toast');
  
  // Create toast if it doesn't exist
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    document.body.appendChild(toast);
    
    // Add styles
    toast.style.position = 'fixed';
    toast.style.bottom = '20px';
    toast.style.left = '50%';
    toast.style.transform = 'translateX(-50%)';
    toast.style.backgroundColor = 'rgba(0, 0, 0, 0.8)';
    toast.style.color = 'white';
    toast.style.padding = '10px 20px';
    toast.style.borderRadius = '5px';
    toast.style.zIndex = '1000';
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s';
  }
  
  toast.textContent = message;
  toast.style.opacity = '1';
  
  setTimeout(() => {
    toast.style.opacity = '0';
  }, 3000);
}

// Handle the form submission
const handleFormSubmit = async (e) => {
  e.preventDefault();
  const userMessage = promptInput.value.trim();
  if (!userMessage || document.body.classList.contains("bot-responding")) return;
  
  userData.message = userMessage;
  promptInput.value = "";
  document.body.classList.add("chats-active", "bot-responding");
  fileUploadWrapper.classList.remove("file-attached", "img-attached", "active");
  
  // Generate user message HTML with optional file attachment
  const userMsgHTML = `
    <p class="message-text"></p>
    ${userData.file.data ? (userData.file.isImage ? `<img src="data:${userData.file.mime_type};base64,${userData.file.data}" class="img-attachment" />` : `<p class="file-attachment"><span class="material-symbols-rounded">description</span>${userData.file.fileName}</p>`) : ""}
  `;
  
  const userMsgDiv = createMessageElement(userMsgHTML, "user-message");
  userMsgDiv.querySelector(".message-text").textContent = userData.message;
  chatsContainer.appendChild(userMsgDiv);
  scrollToBottom();
  
  setTimeout(async () => {
    // Generate bot message HTML and add in the chat container
    const botMsgHTML = `<img class="avatar" src="gemini.svg" /> <p class="message-text">Processing your request...</p>`;
    const botMsgDiv = createMessageElement(botMsgHTML, "bot-message", "loading");
    chatsContainer.appendChild(botMsgDiv);
    scrollToBottom();
    
    // Submit job to API
    const jobId = await submitJob(userData.message, userData.file);
    
    if (jobId) {
      botMsgDiv.setAttribute('data-job-id', jobId);
      
      // Add to chat history
      chatHistory.push({
        role: "user",
        parts: [{ text: userData.message }, ...(userData.file.data ? [{ inline_data: (({ fileName, isImage, ...rest }) => rest)(userData.file) }] : [])],
      });
    } else {
      botMsgDiv.classList.remove("loading");
      botMsgDiv.querySelector(".message-text").textContent = "Failed to process request. Please try again.";
      botMsgDiv.querySelector(".message-text").style.color = "#d62939";
      document.body.classList.remove("bot-responding");
    }
    
    // Reset file data
    userData.file = {};
  }, 600); // 600 ms delay
};

// Handle file input change (file upload)
fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  if (!file) return;
  const isImage = file.type.startsWith("image/");
  const reader = new FileReader();
  reader.readAsDataURL(file);
  reader.onload = (e) => {
    fileInput.value = "";
    const base64String = e.target.result.split(",")[1];
    fileUploadWrapper.querySelector(".file-preview").src = e.target.result;
    fileUploadWrapper.classList.add("active", isImage ? "img-attached" : "file-attached");
    // Store file data in userData obj
    userData.file = { fileName: file.name, data: base64String, mime_type: file.type, isImage };
  };
});

// Cancel file upload
document.querySelector("#cancel-file-btn").addEventListener("click", () => {
  userData.file = {};
  fileUploadWrapper.classList.remove("file-attached", "img-attached", "active");
});

// Stop Bot Response
document.querySelector("#stop-response-btn").addEventListener("click", () => {
  if (currentJobId) {
    // Close WebSocket
    if (websocket && websocket.readyState !== WebSocket.CLOSED) {
      websocket.close();
    }
    
    // Stop typing effect
    clearInterval(typingInterval);
    
    // Update UI
    const botMsgDiv = document.querySelector(`.bot-message[data-job-id="${currentJobId}"]`);
    if (botMsgDiv) {
      botMsgDiv.classList.remove("loading");
      botMsgDiv.querySelector(".message-text").textContent = "Response generation stopped.";
    }
    document.body.classList.remove("bot-responding");
  }
});

// Toggle dark/light theme
themeToggleBtn.addEventListener("click", () => {
  const isLightTheme = document.body.classList.toggle("light-theme");
  localStorage.setItem("themeColor", isLightTheme ? "light_mode" : "dark_mode");
  themeToggleBtn.textContent = isLightTheme ? "dark_mode" : "light_mode";
});

// Delete all chats
document.querySelector("#delete-chats-btn").addEventListener("click", () => {
  chatHistory.length = 0;
  chatsContainer.innerHTML = "";
  document.body.classList.remove("chats-active", "bot-responding");
});

// Handle suggestions click
document.querySelectorAll(".suggestions-item").forEach((suggestion) => {
  suggestion.addEventListener("click", () => {
    promptInput.value = suggestion.querySelector(".text").textContent;
    promptForm.dispatchEvent(new Event("submit"));
  });
});

// Show/hide controls for mobile on prompt input focus
document.addEventListener("click", ({ target }) => {
  const wrapper = document.querySelector(".prompt-wrapper");
  const shouldHide = target.classList.contains("prompt-input") || (wrapper.classList.contains("hide-controls") && (target.id === "add-file-btn" || target.id === "stop-response-btn"));
  wrapper.classList.toggle("hide-controls", shouldHide);
});

// Add event listeners for form submission and file input click
promptForm.addEventListener("submit", handleFormSubmit);
promptForm.querySelector("#add-file-btn").addEventListener("click", () => fileInput.click());

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
  loadJobHistory();
});