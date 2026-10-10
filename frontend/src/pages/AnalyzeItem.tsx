import React from 'react'
import type { WorkflowState } from '@/types/workflow'
import { OrchestratorStudio } from '@/components/orchestrator/OrchestratorStudio'

interface AnalyzeItemProps {
  onNavigateToAgents?: () => void
  onWorkflowComplete?: (wf: WorkflowState) => void
}

export const AnalyzeItem: React.FC<AnalyzeItemProps> = ({ onNavigateToAgents }) => {
  return <OrchestratorStudio onNavigateToAgents={onNavigateToAgents} />
}

export default AnalyzeItem
