import React, { useEffect, useState } from 'react';
import { useNavigate } from '@remix-run/react';
import type { ShowcaseTemplate } from '~/types/showcase-template';
import { loadShowcaseTemplates } from '~/utils/showcase-templates';
import { TemplateCard } from './TemplateCard';

export const TemplateSection: React.FC = () => {
  const navigate = useNavigate();
  const [templates, setTemplates] = useState<ShowcaseTemplate[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadShowcaseTemplates()
      .then((data) => {
        setTemplates(data.slice(0, 4));
      })
      .catch(() => {
        setTemplates([]);
      })
      .finally(() => setLoading(false));
  }, []);

  const handleTemplateClick = (template: ShowcaseTemplate) => {
    navigate(`/templates?selected=${template.id}`);
  };

  if (loading) {
    return (
      <div className="w-full max-w-chat mx-auto mt-4 px-4">
        <div className="flex items-center justify-center py-4">
          <div className="i-svg-spinners:90-ring-with-bg text-lg text-devonz-elements-loader-progress" />
        </div>
      </div>
    );
  }

  if (templates.length === 0) {
    return null;
  }

  return (
    <div className="w-full max-w-chat mx-auto mt-4 px-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-[#9ca3af]">Templates</h3>
        <button
          onClick={() => navigate('/templates')}
          className="text-xs text-[#9ca3af] hover:text-white transition-colors duration-200 flex items-center gap-1 group"
        >
          View all
          <div className="i-ph:arrow-right text-xs transition-transform duration-200 group-hover:translate-x-0.5" />
        </button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {templates.map((template) => (
          <TemplateCard key={template.id} template={template} onClick={handleTemplateClick} />
        ))}
      </div>
    </div>
  );
};
