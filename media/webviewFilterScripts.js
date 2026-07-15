function initFiltering(activeByDefault, dashboard) {
    const storageKey = 'filterValue';
    const hasFilterValueClass = 'has-filter-value';
    const filterInput = document.getElementById('filter');
    const clearSearchElement = document.getElementById('clear');
    const filterWrapper = filterInput.parentElement;

    function apply() {
        var filterValue = filterInput.value || '';
        filterWrapper.classList.toggle(hasFilterValueClass, filterValue.length > 0);
        sessionStorage.setItem(storageKey, filterValue);
        dashboard.setSearchQuery(filterValue);
    }

    function clear() {
        filterInput.value = '';
        sessionStorage.setItem(storageKey, '');
        filterWrapper.classList.remove(hasFilterValueClass);
        dashboard.setSearchQuery('');
        filterInput.focus();
    }

    function focus() {
        filterInput.focus();
        filterInput.select();
    }

    filterInput.addEventListener('input', apply);
    filterInput.addEventListener('change', apply);
    clearSearchElement.addEventListener('click', clear);
    window.addEventListener('keydown', event => {
        if (event.key.toLowerCase() === 'f' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            focus();
            return;
        }
        if (event.key === 'Escape' && (filterInput.value || dashboard.isSearchActive())) {
            event.preventDefault();
            clear();
        }
    });

    var storedFilter = sessionStorage.getItem(storageKey) || '';
    filterInput.value = storedFilter;
    filterWrapper.classList.toggle(hasFilterValueClass, storedFilter.length > 0);
    document.body.classList.add('filtering-active');
    if (activeByDefault && !storedFilter) {
        requestAnimationFrame(focus);
    }

    return { clear, focus, apply };
}
