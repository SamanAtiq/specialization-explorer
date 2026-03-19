import { Card, CardContent } from "@/components/ui/card";

// Props for saving a user's message as a shared prompt
type UserChatMessageProps = {
  text: string;
  messageTime?: number;
  initialLoadTime?: number | null;
  id?: string;
};

export default function UserChatMessage({ text, messageTime, initialLoadTime, id }: UserChatMessageProps) {
  return (
    // main msg container
    <div className="flex flex-col items-end gap-1 group">
      <div className="flex justify-end w-full">
        <Card className="py-[10px] max-w-[90%]">
          <CardContent className="px-[10px] text-sm lg:text-md break-words">
            <p className="whitespace-pre-wrap">{text}</p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
