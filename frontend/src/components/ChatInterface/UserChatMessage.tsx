import { Card, CardContent } from "@/components/ui/card";

type UserChatMessageProps = {
  text: string;
};

export default function UserChatMessage({ text }: UserChatMessageProps) {
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
