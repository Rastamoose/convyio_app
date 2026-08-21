export interface Project {
  id: string;
  ownerName: string;
}

export function projectResponse(project: Project) {
  return {
    id: project.id,
    owner_name: project.ownerName,
  };
}
