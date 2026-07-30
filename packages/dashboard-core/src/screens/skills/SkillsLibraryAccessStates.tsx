import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  PageHeader,
  PageScaffold,
} from "@selftune/ui/components";
import { Button, Card } from "@selftune/ui/primitives";

const description = "Monitor and manage skill definitions across every connected source.";

export function SkillsLibraryUnavailable({ reason }: { reason: string }) {
  return (
    <PageScaffold data-parity-root="skills-library">
      <PageHeader title="Skills Library" description={description} />
      <Card>
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Skills Library unavailable</EmptyTitle>
            <EmptyDescription>{reason}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </Card>
    </PageScaffold>
  );
}

export function SkillsLibraryUpgrade({ href }: { href: string }) {
  return (
    <PageScaffold data-parity-root="skills-library">
      <PageHeader title="Skills Library" description={description} />
      <Card>
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Upgrade to use the Skills Library</EmptyTitle>
            <EmptyDescription>
              This server exposes the Library as an upgrade-only capability.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button nativeButton={false} render={<a href={href} />}>
              View upgrade options
            </Button>
          </EmptyContent>
        </Empty>
      </Card>
    </PageScaffold>
  );
}
