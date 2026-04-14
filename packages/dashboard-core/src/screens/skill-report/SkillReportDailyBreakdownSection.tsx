"use client";

import type { ReactNode } from "react";

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@selftune/ui/primitives";

export interface SkillReportDailyBreakdownRow {
  date: string;
  evalCount: number;
  passRate: number;
  explicit: number;
  implicit: number;
  contextual: number;
}

export interface SkillReportDailyBreakdownSectionProps {
  rows: SkillReportDailyBreakdownRow[];
  title?: ReactNode;
  maxRows?: number;
}

function formatShortDate(dateStr: string): string {
  const date = new Date(dateStr);
  if (Number.isNaN(date.getTime())) return dateStr;
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatPercent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

export function SkillReportDailyBreakdownSection({
  rows,
  title = "Daily Breakdown",
  maxRows = 14,
}: SkillReportDailyBreakdownSectionProps) {
  if (rows.length === 0) return null;

  return (
    <Card className="bg-muted border-none shadow-none ring-0">
      <CardHeader>
        <CardTitle className="font-headline text-lg tracking-tight">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="text-xs uppercase text-muted-foreground">Date</TableHead>
              <TableHead className="text-xs uppercase text-muted-foreground">Evals</TableHead>
              <TableHead className="text-xs uppercase text-muted-foreground">Pass Rate</TableHead>
              <TableHead className="text-xs uppercase text-muted-foreground">Explicit</TableHead>
              <TableHead className="text-xs uppercase text-muted-foreground">Implicit</TableHead>
              <TableHead className="text-xs uppercase text-muted-foreground">Contextual</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.slice(0, maxRows).map((row) => (
              <TableRow key={row.date}>
                <TableCell className="text-foreground">{formatShortDate(row.date)}</TableCell>
                <TableCell className="font-mono text-muted-foreground">{row.evalCount}</TableCell>
                <TableCell className="font-mono">
                  <span
                    className={
                      row.passRate >= 0.8
                        ? "text-primary"
                        : row.passRate >= 0.6
                          ? "text-amber-400"
                          : "text-red-400"
                    }
                  >
                    {formatPercent(row.passRate)}
                  </span>
                </TableCell>
                <TableCell className="font-mono text-muted-foreground">{row.explicit}</TableCell>
                <TableCell className="font-mono text-muted-foreground">{row.implicit}</TableCell>
                <TableCell className="font-mono text-muted-foreground">{row.contextual}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
