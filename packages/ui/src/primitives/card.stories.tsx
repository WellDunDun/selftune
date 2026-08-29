import type { Meta, StoryObj } from "@storybook/nextjs-vite";

import { Button } from "./button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "./card";

const meta = {
  component: Card,
  tags: ["ai-generated"],
} satisfies Meta<typeof Card>;

export default meta;
type Story = StoryObj<typeof meta>;

export const EvidenceSummary: Story = {
  render: () => (
    <Card className="max-w-md">
      <CardHeader>
        <CardTitle>Evaluation complete</CardTitle>
        <CardDescription>The candidate passed all sealed holdouts.</CardDescription>
        <CardAction>
          <Button size="sm">Review</Button>
        </CardAction>
      </CardHeader>
      <CardContent>12 of 12 checks passed with no regressions.</CardContent>
      <CardFooter>Ready for review</CardFooter>
    </Card>
  ),
};

export const Compact: Story = {
  render: () => (
    <Card size="sm" className="max-w-sm">
      <CardHeader>
        <CardTitle>No winner</CardTitle>
      </CardHeader>
      <CardContent>The incumbent remains installed.</CardContent>
    </Card>
  ),
};
