import {
    OpenProjectPublication,
    validateOpenProjectPublication,
} from '../../../src/openProjects/protocol';

export function replaceOpenProjectPublicationUris(
    raw: unknown,
    workspaceUris: readonly string[],
): OpenProjectPublication {
    const publication = validateOpenProjectPublication(raw);
    return validateOpenProjectPublication({
        ...publication,
        projects: publication.projects.map(project => ({
            ...project,
            uri: workspaceUris[project.ordinal] || project.uri,
        })),
    });
}
