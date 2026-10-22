import { useMemo } from 'react';
import { type NodeEcon, computeMeshScore } from '@/lib/mesh-score';
import type { SshHost } from './types';

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface MeshScoreInputs {
  allNodes: { meshNode: any; sshHost?: SshHost; key: string }[];
  meshNodes: any[];
  getNodeEcon: (hostname: string) => NodeEcon;
  geoipNodes: any[];
}

/**
 * Per-node economics plus the mesh score derived from them. Shared by the
 * economics panel (headline numbers, top of page) and the fleet charts
 * (below the node grid) so both read the same blended $/kWh.
 */
export function useMeshScore({ allNodes, meshNodes, getNodeEcon, geoipNodes }: MeshScoreInputs) {
  const firstMeshHostname = meshNodes[0]?.hostname;
  const econNodes = useMemo(() =>
    allNodes.map(n => ({
      hostname: n.key,
      sshHostname: n.sshHost?.hostname,
      econ: getNodeEcon(n.key),
      meshNode: n.meshNode,
    })),
    [allNodes, getNodeEcon]
  );
  const score = useMemo(() => computeMeshScore(econNodes, geoipNodes, firstMeshHostname), [econNodes, geoipNodes, firstMeshHostname]);
  return { econNodes, score };
}
