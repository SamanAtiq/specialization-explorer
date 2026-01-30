# User Guide

**Before you start:** confirm the app is deployed using the deployment guide at `Docs/DEPLOYMENT_GUIDE.md`.

This document summarizes the main user flows, UI controls, and administrative actions in the Specialization Explorer frontend. It reflects the current UI and behavior implemented in the frontend code (chat, prompts, practice generation, audio, and admin features).

| Index    | Description |
| -------- | ------- |
| [Getting Started](#getting-started) | Create an account and get started with the app |
| [Student View](#student-view) | Browse textbooks, use the Chat interface, and generate practice materials |
| [Instructor View](#instructor-view) | Create, edit, and export practice materials (H5P / PDF) |
| [Administrator View](#administrator-view) | Admin dashboards: ingestion, moderation, AI settings, analytics |

---

## Getting Started

1. Open the hosted site (Amplify URL provided in the deployment process) or run the frontend locally.
---

## Student View
![image](./media/landing_page.png)

This is the default experience and contains: textbook catalog, Chat (Study Companion), FAQ, Practice Materials, Shared Prompts, and audio accessibility settings.

### Home / Textbook Catalog

![textbook_catalogue](./media/textbook_catalogue.png)
- Browse textbook cards with title, author, and cover image. Use the search bar to find textbooks by title or author.
- Click a textbook to view the textbook dashboard, which includes Chat, FAQ, Practice, and (for instructors) Material Editor.
### Chat (Study Companion)
![chat_window](./media/chat_window.png)
- In the sidebar a user can select existing chat sessions or create a new session with the **+** button.
- To delete a chat session, click the delete (trash) icon on a session in the sidebar; if you are the session owner, the session will be removed immediately. Administrators can delete any session via the admin dashboard. The operation is performed via the `DELETE /chat_sessions/{chat_session_id}` endpoint.
- Type messages into the Chat input; press **Enter** to send (Shift+Enter inserts a newline).
- Responses stream as the model generates them and may contain sources (citations) displayed below the reply.
![chat_response](./media/AI_response.png)
- The Chat supports prompt templates and guided prompts — open the Prompt Library to browse or apply templates.

- Session data is stored in localStorage and is valid for approximately 30 days; sessions are temporary and not a durable storage mechanism.

Sharing chats:
![share_chat](./media/share_chat_message.png)
- Use the **Share** button to generate a public URL for the conversation. A privacy notice will appear before proceeding; you can dismiss it permanently using localStorage.
- If you open a shared chat URL, you can preview and optionally fork the conversation into your own chat session.

### FAQ
![faq](./media/faq_page.png)
- The FAQ for each textbook lists commonly asked questions and the canonical answer.
- Clicking a FAQ loads it as a pre-filled question into the Chat UI and increments its usage count.
- To report an FAQ, click the flag icon on the FAQ Card.

### Practice Materials
![practice_material](./media/practice_material.png)
- Use the Practice tab to generate MCQs, Flashcards, and Short Answer question sets.
- Validations and generation constraints (client-side):
  - MCQ: 
  - Flashcards
  - Short Answer
- Generated materials are session-scoped and can be exported.

 Grading:
- The Short Answer material type supports a text grading/feedback flow (AI-assisted). The UI will show grading results where applicable.
- MCQ material type will provide feedback based on whether the user chooses the correct or wrong answer. The UI will show hints or feedback as needed.
- Flashcard is self graded. 

### Shared Prompts
![shared_user_prompts](./media/shared_user_prompts.png)
- Browse prompts shared by other users in the Shared Prompts tab.
- Use the inline prompt card to insert the prompt into your chat session.
- Report inappropriate shared prompts using the inline Flag icon on the prompt card.

### Audio Controls

- Open Audio Settings from the Sidebar to enable Narration, Autoplay, and choose which messages should be read (`Both`, `AI only`, `User only`).
- Choose Voice, and set Rate, Pitch, and Volume. Use Play Sample to preview the voice.

---

## Instructor View

Switch to Instructor mode via the Mode selector (top header). Instructors have access to the Material Editor and additional tools.

### Material Editor & H5P Export
![material_editor](./media/material_editor.png)
- Use the Material Editor to review and edit MCQ, Short Answer, and Flashcard sets.
- Edit questions, re-order, add options or explanations, and then export edits to H5P or PDF.
- H5P export triggers the server-side packaging process and returns a downloadable zip file that can be imported into LMS platforms like Canvas or Moodle.
- PDF export has 2 different modes. One is questions only, for students to use and another with the answers included for instructor use.
---

## Administrator View
![admin_login](./media/admin_login.png)
Administrators log in via `/admin/login` and perform ingestion, metadata, moderation, and system configuration tasks.

### Textbook Management & Ingestion
![admin_dashboard](./media/admin_dashboard.png)
- View ingestion status, job history, and content ingestion statistics in the Textbooks page.
- Add or update textbook metadata and trigger re-ingestion when necessary
![textbook_ingestion](./media/textbook_ingestion.png)
### AI System & Operational Settings
![ai_settings](./media/ai_settings.png)
- Manage the system prompt, set token limits, and update operational settings in AI Settings.

### Analytics
![textbook_info](./media/textbook_info.png)
- Console shows usage and activity metrics such as chat counts, prompt usage, and practice generation activity.

### Reported Content & Moderation
![reported_content](./media/reported_faq_and_prompts.png)
- Review reported items for FAQ and shared prompts; each report includes optional user comments.
- Actions available: dismiss a report or delete the flagged item.

---

## Reporting & Moderation Flow

- Shared Prompts use an inline Flag control for reporting (opens a dialog for optional comments).
- FAQ entries uses an inline flag control for reporting.
- Admins receive reports in the Admin dashboard under Reported Items.

---

## Troubleshooting & Best Practices

Troubleshooting tips:
- If the frontend cannot reach the backend, verify your `VITE_API_ENDPOINT` setting and Amplify configuration.
- For audio issues, check browser permissions and the selected voice.
- If H5P export fails, check the API logs and ensure the packaging backend is reachable.
- For WebSocket (chat streaming) issues, inspect the browser console for WebSocket endpoints and network errors.
- If you are logged in as an admin, and you have just uploaded new materials, they will initially be disabled by default. Make sure to enable the "status" toggle, and the textbook will be ready for use.

Best practices:
- Be specific with user questions and include a textbook section or page reference to improve source relevance.
- Use the Prompt Library and Guided Prompts to generate repeatable, reproducible prompts.
- Avoid sharing personally identifiable or sensitive information in public shared chat links.
- Export practice sets to H5P or PDF if you require persistent content beyond the session (session data persists for ~30 days).

---

## Additional Resources

- [Deployment Guide](./DEPLOYMENT_GUIDE.md)
- [Architecture Documentation](./ARCHITECTURE.md)
- [API Documentation](./API_DOCUMENTATION.pdf)