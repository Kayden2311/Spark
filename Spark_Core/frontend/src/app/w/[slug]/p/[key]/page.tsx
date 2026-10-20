"use client";

import { ProjectBoard } from "./board";
import { useProject } from "./project-context";

export default function ProjectBoardPage() {
  const { project } = useProject();
  // Keyed by project so a switch between projects never mixes their boards or drafts.
  return <ProjectBoard key={project.id} />;
}
