import { useState, useEffect } from "react";
import DOMPurify from "dompurify";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

// Simple markdown to HTML converter for basic formatting
function simpleMarkdownToHtml(markdown: string): string {
  return markdown
    // Headers
    .replace(/^### (.*$)/gm, '<h3 class="text-lg font-semibold text-primary mt-6 mb-2">$1</h3>')
    .replace(/^## (.*$)/gm, '<h2 class="text-xl font-semibold text-primary mt-8 mb-3">$1</h2>')
    .replace(/^# (.*$)/gm, '<h1 class="text-2xl font-bold text-primary mt-8 mb-4">$1</h1>')
    // Bold and italic
    .replace(/\*\*\*(.*?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    // Links
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" class="text-primary hover:underline" target="_blank" rel="noopener noreferrer">$1</a>')
    // Unordered lists (simple)
    .replace(/^[-*] (.*$)/gm, '<li class="ml-4">$1</li>')
    // Wrap consecutive li elements in ul
    .replace(/(<li[^>]*>.*<\/li>\n?)+/g, '<ul class="list-disc list-inside space-y-2 my-4">$&</ul>')
    // Paragraphs (double newlines)
    .replace(/\n\n/g, '</p><p class="my-4">')
    // Single newlines within paragraphs
    .replace(/\n/g, '<br/>');
}

// Default content shown when no custom guidelines are configured
const DEFAULT_GUIDELINES_CONTENT = `
# Acceptable Use Policy

You agree not to use the Model or its Derivatives in any of the following ways:

## 1. Legal

In any way that violates any available national, federal, provincial, local or international law or regulation.

## 2. Harm and Discrimination

- For the purpose of exploiting, harming or attempting to exploit or harm others in any way;
- To generate or disseminate false information with the purpose of harming others;
- To generate or disseminate personal identifiable information that can be used to harm an individual;
- To defame, disparage or otherwise harass others;
- To generate sexual content that is not educational in nature, especially pertaining to sexual violence or non-consensual intimate content;
- To provide personal medical advice and medical results interpretation;
- For any use intended to or which has the effect of harming individuals or groups based on online or offline social behavior or known or predicted personal or personality characteristics;
- To exploit any of the vulnerabilities of a specific group of persons based on their age, social, physical or mental characteristics, in order to materially distort the behavior of a person belonging to that group in a manner that causes or is likely to cause that person or another person physical or psychological harm;
- For any use intended to or which has the effect of discriminating against individuals or groups based on gender, gender identity and expression, sexual orientation, ability, physical appearance, body size, race, ethnicity, age, or religion.

## 3. Disclosure and Transparency

- To generate or disseminate machine-generated information or content in any medium (e.g. school assignments, exams, or lecture materials) without expressly and intelligibly disclaiming that it is machine-generated;
- To generate or disseminate information or content, in any context without expressly and intelligibly disclaiming that the text is machine generated;
- To impersonate or attempt to impersonate human beings for purposes of deception;
- For fully automated decision-making that adversely impacts an individual's legal rights or otherwise creates or modifies a binding, enforceable obligation.

---

*The User Guidelines is adapted from [AI Pubs Open RAIL-M License Use Restrictions](https://www.licenses.ai/ai-pubs-open-railm-vz1) for non-commercial purposes.*

# Privacy Statement

We believe in protecting your privacy and recognizes the sensitivity of Personal Information. This statement outlines how we manage your Personal Information and safeguard your privacy.

## Your Information

- Personal information is not collected when using unless explicitly submitted and saved by you.
- User history is stored for 30 days. Local session data is persisted in your browser for approximately 30 days to provide continuity of session across reloads.
- Only user prompts that you choose to save will remain beyond this timeframe; those saved prompts cannot be traced back to a user via the frontend UI.
`;

export default function UserGuidelines() {
  const [guidelines, setGuidelines] = useState<string>("");
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const fetchGuidelines = async () => {
      try {
        const response = await fetch(
          `${import.meta.env.VITE_API_ENDPOINT}/public/config/userGuidelines`
        );

        if (response.ok) {
          const data = await response.json();
          if (data.userGuidelines && data.userGuidelines.trim() !== "") {
            setGuidelines(data.userGuidelines);
          } else {
            // Use default content if no custom guidelines
            setGuidelines(DEFAULT_GUIDELINES_CONTENT);
          }
        } else {
          // Use default content on error
          setGuidelines(DEFAULT_GUIDELINES_CONTENT);
        }
      } catch (error) {
        console.error("Error fetching user guidelines:", error);
        // Use default content on error
        setGuidelines(DEFAULT_GUIDELINES_CONTENT);
      } finally {
        setIsLoading(false);
      }
    };

    fetchGuidelines();
  }, []);

  // Convert markdown to HTML and sanitize to prevent XSS
  const renderedContent = DOMPurify.sanitize(simpleMarkdownToHtml(guidelines), {
    ALLOWED_TAGS: ['h1', 'h2', 'h3', 'h4', 'p', 'br', 'strong', 'em', 'a', 'ul', 'ol', 'li', 'div'],
    ALLOWED_ATTR: ['href', 'class', 'target', 'rel'],
  });

  return (
    <div className="pt-[70px] flex min-h-screen flex-col bg-background">

      {/* Main Content */}
      <main className="container mx-auto flex-1 px-6 py-16">
        <div className="mx-auto max-w-4xl">
          {/* Hero Section */}
          <div className="mb-12 text-center space-y-4">
            <h1 className="text-5xl font-bold tracking-tight text-primary">
              User Guidelines
            </h1>
            <p className="text-xl text-muted-foreground max-w-2xl mx-auto">
              Please review these guidelines
            </p>
          </div>

          {/* Guidelines Content */}
          <Card className="shadow-lg">
            <CardHeader>
              <CardTitle className="text-2xl">Guidelines & Policies</CardTitle>
            </CardHeader>
            <CardContent className="prose prose-slate max-w-none">
              {isLoading ? (
                <div className="flex items-center justify-center py-12">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
                </div>
              ) : (
                <div
                  className="space-y-4 text-base leading-relaxed"
                  dangerouslySetInnerHTML={{ __html: renderedContent }}
                />
              )}
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
}
