import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { z } from 'zod';
import type { RoleDefinition } from './types.js';

// ── Schema ──────────────────────────────────────────────────────

export const ProjectManifestSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  paths: z.array(z.string()),
  roles: z.array(z.string()).min(1),
});

export type Project = z.infer<typeof ProjectManifestSchema>;

// ── Loader ──────────────────────────────────────────────────────

/**
 * Scan `.projects/` for project manifests, validate against schema, return registry.
 * Fails fast on schema errors or duplicate names.
 */
export function loadProjects(
  projectsDir: string,
  roles: Map<string, RoleDefinition>,
): Map<string, Project> {
  const projects = new Map<string, Project>();

  if (!fs.existsSync(projectsDir)) {
    return projects;
  }

  const entries = fs.readdirSync(projectsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory());

  for (const entry of entries) {
    const manifestPath = path.join(projectsDir, entry.name, 'project.yaml');
    if (!fs.existsSync(manifestPath)) continue;

    let raw: unknown;
    try {
      const content = fs.readFileSync(manifestPath, 'utf-8');
      raw = yaml.load(content);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to read ${manifestPath}: ${msg}`);
    }

    const result = ProjectManifestSchema.safeParse(raw);
    if (!result.success) {
      const issues = result.error.issues
        .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
        .join('\n');
      throw new Error(`${manifestPath}: invalid project manifest:\n${issues}`);
    }

    const project = result.data;

    // Validate: name uniqueness
    if (projects.has(project.name.toLowerCase())) {
      throw new Error(`Duplicate project name "${project.name}" in ${manifestPath}`);
    }

    // Validate: roles reference loaded roles
    for (const roleName of project.roles) {
      if (!roles.has(roleName)) {
        const available = [...roles.keys()].join(', ');
        throw new Error(
          `${manifestPath}: role "${roleName}" not found. Available: ${available}`,
        );
      }
    }

    projects.set(project.name.toLowerCase(), project);
  }

  return projects;
}

// ── Helpers ──────────────────────────────────────────────────────

export function projectHasPaths(project: Project): boolean {
  return project.paths.length > 0;
}

/**
 * Scaffold a new project manifest on disk and return the Project.
 * Creates `.projects/<name>/project.yaml` with `paths: []`.
 */
export function createProject(
  projectsDir: string,
  manifest: { name: string; description: string; roles: string[] },
  roles: Map<string, RoleDefinition>,
): Project {
  // Validate roles exist
  for (const roleName of manifest.roles) {
    if (!roles.has(roleName)) {
      const available = [...roles.keys()].join(', ');
      throw new Error(`Role "${roleName}" not found. Available: ${available}`);
    }
  }

  const projectDir = path.join(projectsDir, manifest.name.toLowerCase());

  // Ensure .projects/ and project dir exist
  fs.mkdirSync(projectDir, { recursive: true });

  const project: Project = {
    name: manifest.name,
    description: manifest.description,
    paths: [],
    roles: manifest.roles,
  };

  const yamlContent = yaml.dump(project, { lineWidth: -1 });
  fs.writeFileSync(path.join(projectDir, 'project.yaml'), yamlContent, 'utf-8');

  return project;
}

// ── Lookup helpers ───────────────────────────────────────────────

export function getProject(projects: Map<string, Project>, name: string): Project {
  const project = projects.get(name.toLowerCase());
  if (!project) {
    const available = [...projects.values()].map((p) => p.name).join(', ');
    throw new Error(`Project "${name}" not found. Available: ${available || '(none)'}`);
  }
  return project;
}

export function listProjects(projects: Map<string, Project>): Project[] {
  return [...projects.values()];
}

export function getProjectTasksDir(projectsDir: string, projectName: string): string {
  return path.join(projectsDir, projectName.toLowerCase(), 'tasks');
}
