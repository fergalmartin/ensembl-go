import AppButtonIcon from './AppButtonIcon'

function HomeView({ theme, onNavigate }) {
  const isLight = theme === 'light'

  const cardBg = isLight
    ? 'bg-white border border-gray-200 shadow-sm hover:shadow-md hover:border-[#0099ff]/40'
    : 'bg-gray-800 border border-gray-700 hover:border-blue-500/50 hover:shadow-lg hover:shadow-blue-500/10'
  const cardText = isLight ? 'text-gray-900' : 'text-gray-100'
  const cardSubtext = isLight ? 'text-gray-500' : 'text-gray-400'

  const views = [
    {
      id: 'species_selector',
      title: 'Genome Selector',
      description: 'Select downloaded genomes for visualisation.',
      icon: (
        <svg width="40" height="40" viewBox="0 0 36 36" fill="currentColor" stroke="none" className="text-white">
          <path d="M20.0999756,10.2999878c1,0,1.5,1,1.5,1.7999878c0,1.3000488-1.0999756,3.1000366-2.6999512,3.1000366
	c-1.1000366,0-1.5-0.9000244-1.5-1.7999878C17.4000244,12.0999756,18.5,10.2999878,20.0999756,10.2999878z M16.5999756,5.9000244
	c1.2000122,0,1.8000488,1.1999512,1.8000488,2.1999512c0,1.3000488-0.9000244,3.1000366-2.5,3.1000366
	C14.5999756,11.2999878,14.0999756,10.0999756,14.0999756,9C14.0999756,7.7000122,15,5.9000244,16.5999756,5.9000244z
	 M19.0999756,18.5999756c0,1.2000122-1,1.3000488-2,1.3000488c-1.2999878,0-2.2999878-0.8000488-3.5999756-0.8000488
	s-2.4000244,0.8000488-3.7999878,0.8000488c-0.9000244,0-1.7999878-0.3000488-1.7999878-1.3000488
	c0-2.1999512,3.1999512-5.3999634,5.5-5.3999634C15.7000122,13.2000122,19.0999756,16.4000244,19.0999756,18.5999756z M10.5999756,6
	c1.6000366,0,2.5,1.9000244,2.5,3.0999756c0,1-0.5999756,2.2000122-1.7999878,2.2000122c-1.5999756,0-2.5-1.8999634-2.5-3.0999756
	C8.7999878,7.2000122,9.4000244,6,10.5999756,6z M5.5999756,12.0999756c0-0.8999634,0.5-1.7999878,1.5-1.7999878
	c1.5,0,2.7000122,1.7999878,2.7000122,3.1000366c0,0.8999634-0.5,1.7999878-1.5,1.7999878
	C6.7999878,15.2000122,5.5999756,13.4000244,5.5999756,12.0999756z M27.2000122,24.7000122
	C29.0999756,25.5,29.9000244,28,29.9000244,28s-2.2000122,1.0999756-4.1000366,0.2999878
	c-1.5-0.5999756-1.8277588-2.5228271-2.1277466-3.1228027c-1.0281372,0.536438-3,1.1970215-4.3510132,1.355957
	C20.1557007,26.6722412,20.9000244,27,21.2999878,27.4000244c1.2000122,1.2999878,0.7999878,3.6999512,0.7999878,3.6999512
	s-2.1999512,0-3.3999634-1.3999634c-0.9000244-1-0.4515991-2.4119263-0.2131958-3.1072388
	C17.1159668,26.7318115,14.7999878,26.4000244,13.2999878,26c-1.9949341-0.4987183-4.0727539-1.4329834-5.869751-2.52948
	c-0.0377808-0.0292358-0.0656128-0.0693359-0.0656128-0.1208496c0-0.0222778,0.0153809-0.0377808,0.0236206-0.0570679
	l-0.0029297-0.0179443l0.3113403-0.5020752l0.0070801-0.0006714c0.0291748-0.0309448,0.0690308-0.0512085,0.1149292-0.0512085
	c0.031311,0,0.0911255,0.0322266,0.0911255,0.0322266C10.1098022,24.0529175,12.4000244,25,14.5999756,25.4000244
	c0-0.6000366,0-1.4000244,0.4000244-2c0.7999878-1.2000122,2.7000122-1.3000488,2.7000122-1.3000488
	s0.3856812,1.7356567-0.2264404,2.6450806c-0.2587891,0.3843994-0.9735107,0.7351074-2.1854248,0.8543091
	c2.9403687,0.2384033,4.3981323,0.017395,5.515686-0.2507935c-0.6332397-0.7748413-1.4038086-2.048584-1.0038452-3.4485474
	C20.5,20,22.7000122,19,22.7000122,19S24.0999756,21.2000122,23.5,23.0999756
	c-0.2000122,0.7000122-1.4032593,1.6473999-2.0032959,2.0474243c1.2000122-0.5,3.0891113-1.4542847,3.8890991-2.3543091
	c-0.1000366-0.9000244-0.2858276-2.6931152,0.7141724-3.8930664c1.4000244-1.7000122,4.3000488-1.6000366,4.3000488-1.6000366
	s0.3999634,2.6000366-1,4.2999878c-1,1.2000122-2.4645386,1.4464111-3.5374146,1.5060425
	c-0.4022827,0.5662231-1.213562,1.3284302-1.713562,1.7284546C24.9490356,24.6344604,26.4000244,24.2999878,27.2000122,24.7000122z" />
        </svg>
      ),
    },
    {
      id: 'genome_browser',
      title: 'Genome Browser',
      description: 'Browse genomes and annotations, including pairwise genome browsing',
      icon: (
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-white">
          <rect x="2" y="3" width="20" height="18" rx="2" />
          <line x1="2" y1="9" x2="22" y2="9" />
          <circle cx="5.5" cy="6" r="0.8" fill="currentColor" stroke="none" />
          <circle cx="8.5" cy="6" r="0.8" fill="currentColor" stroke="none" />
          <circle cx="11.5" cy="6" r="0.8" fill="currentColor" stroke="none" />
        </svg>
      ),
    },
    {
      id: 'feature_explorer',
      title: 'Feature Explorer',
      description: 'Inspect transcript structures around a selected gene with offset and genomic ruler coordinates.',
      icon: (
        <div className="text-white scale-[1.28]">
          <AppButtonIcon buttonId="feature_explorer" isLight={isLight} />
        </div>
      ),
    },
    {
      id: 'download',
      title: 'Download',
      description: 'Download genomes, annotations and homologies locally.',
      icon: (
        <div className="text-white scale-[1.25]">
          <AppButtonIcon buttonId="download" isLight={isLight} />
        </div>
      ),
    },
    {
      id: 'configuration',
      title: 'Configuration',
      description: 'Set an output directory for local data and set the look and feel',
      icon: (
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      ),
    },
    {
      id: 'alignment',
      title: 'Alignment',
      description: 'Align genic regions across haplotypes or species in the context of annotation',
      icon: (
        <div className="text-white" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', justifyItems: 'center', fontSize: '16px', fontWeight: '800', fontFamily: 'ui-monospace, monospace', lineHeight: 1, gap: '0 2px' }}>
          <span>A</span><span>T</span><span>G</span>
          <div style={{ width: '2.5px', height: '12px', background: 'currentColor', borderRadius: '1px', margin: '3px 0' }}></div>
          <div style={{ width: '2.5px', height: '12px', background: 'currentColor', borderRadius: '1px', margin: '3px 0' }}></div>
          <div style={{ width: '2.5px', height: '12px', background: 'currentColor', borderRadius: '1px', margin: '3px 0' }}></div>
          <span>A</span><span>T</span><span>G</span>
        </div>
      ),
    },
    {
      id: 'neighbourhood',
      title: 'Neighbourhood View',
      description: 'View a simplified gene neighbourhood for genes of interest, compare neighbourhoods across genomes',
      icon: (
        <svg width="40" height="40" viewBox="0 0 24 24" fill="white" stroke="none">
          <path d="M0.5 3.5 h4.5 l2.5 3.5 l-2.5 3.5 h-4.5 z" />
          <path d="M8.5 3.5 h4.5 l2.5 3.5 l-2.5 3.5 h-4.5 z" />
          <path d="M16.5 3.5 h4.5 l2.5 3.5 l-2.5 3.5 h-4.5 z" />
          <path d="M0.5 13.5 h4.5 l2.5 3.5 l-2.5 3.5 h-4.5 z" />
          <path d="M15.5 13.5 h-4.5 l-2.5 3.5 l2.5 3.5 h4.5 z" />
          <path d="M16.5 13.5 h4.5 l2.5 3.5 l-2.5 3.5 h-4.5 z" />
        </svg>
      ),
    },
    {
      id: 'structural_variation',
      title: 'Structural Variation',
      description: 'Inspect structural variation and chain-based syntenic mappings between genomes.',
      icon: (
        <div className="text-white scale-[1.2]">
          <AppButtonIcon buttonId="structural_variation" isLight={isLight} />
        </div>
      ),
    },
    {
      id: 'homology',
      title: 'Homology',
      description: 'Query local homology tables for cross-species matches and ranked candidates',
      icon: (
        <svg width="40" height="40" viewBox="0 0 32 32" fill="white" stroke="none" aria-hidden="true">
          <path d="M24.6,9.1l-1.3,0.7l3,0.8l0.8-2.9l-1.4,0.8c-2.5-3.5-6.7-5.7-11.1-5.7h-0.2v1.3h0.2C18.7,4.1,22.4,6,24.6,9.1z M4.9,11.8
L4,8.9L1,9.7l1.4,0.8c-1.9,3.9-1.7,8.4,0.5,12.1L3,22.7l1.2-0.6L4,21.9c-2-3.3-2.2-7.4-0.5-10.8C3.5,11.1,4.9,11.8,4.9,11.8z
 M25.3,21.7c-2,3.3-5.5,5.5-9.4,5.8l0-1.5l-2.2,2.2l2.2,2.2l0-1.5c4.4-0.3,8.4-2.8,10.6-6.5l0.1-0.1l-1.2-0.6L25.3,21.7z M8.1,22.8
c-1.1,0-2,0.4-2.7,1.1c-0.8,0.7-1.1,1.6-1.1,2.7c0,1,0.4,1.9,1.1,2.7c0.8,0.7,1.7,1.1,2.7,1.1s2-0.4,2.7-1.1
c0.8-0.7,1.1-1.6,1.1-2.7c0-1-0.4-1.9-1.1-2.7C10.2,23.2,9.2,22.7,8.1,22.8z M8.1,1.6c-1.1,0-2,0.4-2.7,1.1C4.6,3.5,4.3,4.3,4.3,5.4
c0,1,0.4,1.9,1.1,2.7c0.8,0.7,1.7,1.1,2.7,1.1s2-0.4,2.7-1.1C11.7,7.3,12,6.4,12,5.4c0-1-0.4-1.9-1.1-2.7C10.2,2,9.2,1.6,8.1,1.6z
 M30.9,14.9c-0.3-1-0.9-1.8-1.8-2.3c-0.9-0.5-1.9-0.6-2.9-0.4c-1,0.3-1.8,0.9-2.4,1.7c-0.5,0.9-0.7,1.8-0.4,2.9
c0.3,1,0.9,1.8,1.8,2.3c0.9,0.5,1.9,0.6,2.9,0.4c1-0.3,1.8-0.9,2.4-1.7C31,16.9,31.1,15.9,30.9,14.9z"/>
        </svg>
      ),
    },
    {
      id: 'stats',
      title: 'Statistics',
      description: 'Compare annotation composition, structural metrics, homology summaries, and assembly metadata.',
      icon: (
        <div className="text-white scale-[1.15]">
          <AppButtonIcon buttonId="stats" isLight={isLight} />
        </div>
      ),
    },
    {
      id: 'track_manager',
      title: 'Track Manager',
      description: 'Register and manage custom data tracks (BigWig, BigBed, VCF, and splice junction files) for display in the genome browser.',
      icon: (
        <div className="text-white scale-[1.1]">
          <AppButtonIcon buttonId="track_manager" isLight={isLight} />
        </div>
      ),
    },
    {
      id: 'help',
      title: 'Help',
      description: 'Open guidance, walkthroughs, and practical notes for each view.',
      icon: (
        <div className="text-white scale-[1.45]">
          <AppButtonIcon buttonId="help" isLight={isLight} />
        </div>
      ),
    },
  ]

  return (
    <div className="h-full flex flex-col items-center overflow-y-auto">
      {/* Ensembl branding */}
      <div className="flex flex-col items-center mt-8 mb-10">
        <div className="flex items-center gap-3 mb-3">
          <img src="ensembl-logotype-blue.svg" alt="Ensembl" className="h-12" />
          <span className={`leading-none ${isLight ? 'text-gray-900' : 'text-white'}`} style={{fontSize: '60px'}}>Go</span>
        </div>
        <p className={`text-lg tracking-wide ${cardSubtext}`}>
          Genome data &amp; annotation
        </p>
      </div>

      {/* View cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6 max-w-6xl w-full px-4 pb-8">
        {views.map(view => (
          <button
            key={view.id}
            onClick={() => onNavigate(view.id)}
            className={`${cardBg} rounded-xl p-6 flex flex-col items-center text-center transition-all duration-200 cursor-pointer`}
          >
            <div className="w-16 h-16 rounded-xl bg-[#0099ff] flex items-center justify-center mb-4">
              {view.icon}
            </div>
            <h3 className={`text-base font-semibold ${cardText} mb-2`}>{view.title}</h3>
            <p className={`text-sm ${cardSubtext} leading-relaxed`}>{view.description}</p>
          </button>
        ))}
      </div>
    </div>
  )
}

export default HomeView
